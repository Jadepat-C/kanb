//! Slows down password guessing and email flooding: sign-in, the two-factor step, "forgot password", reset links and
//! first-run setup. Counts live in memory (one server process), per client address and per account, in sliding windows.
//!
//! The per-account limit means someone can briefly lock an account by failing on purpose; windows are short
//! (15 minutes) to keep that cheap, and the IP limit is checked first so one address can't do it for many accounts.

use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, Ipv6Addr, SocketAddr},
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::http::HeaderMap;

use crate::error::{AppError, AppResult};

/// How many events a key may have within a window.
#[derive(Clone, Copy)]
pub struct Rule {
    pub limit: usize,
    pub window: Duration,
}

const MIN15: Duration = Duration::from_secs(15 * 60);
/// Wrong passwords from one address (an office behind one NAT shares it, so not too low).
pub const LOGIN_IP: Rule = Rule { limit: 30, window: MIN15 };
/// Wrong passwords for one account, from anywhere.
pub const LOGIN_ACCOUNT: Rule = Rule { limit: 10, window: MIN15 };
/// Wrong two-factor codes for one account (each sign-in ticket also allows only 5).
pub const CODE_ACCOUNT: Rule = Rule { limit: 10, window: MIN15 };
/// "Forgot password" requests: every request counts, wrong or right.
pub const FORGOT_IP: Rule = Rule { limit: 10, window: MIN15 };
pub const FORGOT_ACCOUNT: Rule = Rule { limit: 3, window: Duration::from_secs(60 * 60) };
/// Invalid reset links and wrong setup codes from one address.
pub const TOKEN_IP: Rule = Rule { limit: 20, window: MIN15 };

const MAX_KEYS: usize = 50_000;
const MAX_WINDOW: Duration = Duration::from_secs(60 * 60);

#[derive(Default)]
pub struct Limiter {
    keys: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl Limiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Err(429) while `key` has used up `rule` within its window.
    pub fn check(&self, key: &str, rule: Rule) -> AppResult<()> {
        let now = Instant::now();
        let mut map = self.keys.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(q) = map.get_mut(&clip(key)) {
            while q.front().is_some_and(|t| now.duration_since(*t) >= rule.window) {
                q.pop_front();
            }
            if q.len() >= rule.limit {
                let oldest = *q.front().expect("non-empty");
                let wait = rule.window.saturating_sub(now.duration_since(oldest));
                return Err(AppError::TooManyRequests(wait.as_secs().max(1)));
            }
        }
        Ok(())
    }

    /// Records one event (a failure, or a request for limits that count every request).
    pub fn hit(&self, key: &str, rule: Rule) {
        let now = Instant::now();
        let mut map = self.keys.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= MAX_KEYS {
            // attacker-chosen keys must not grow memory without bound: drop everything that has expired first
            map.retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < MAX_WINDOW));
            if map.len() >= MAX_KEYS {
                map.clear();
            }
        }
        let q = map.entry(clip(key)).or_default();
        q.push_back(now);
        while q.len() > rule.limit {
            q.pop_front();
        }
    }

    /// Forgets a key (an account after a successful sign-in).
    pub fn clear(&self, key: &str) {
        self.keys.lock().unwrap_or_else(|e| e.into_inner()).remove(&clip(key));
    }
}

/// Keys include text people typed (usernames): keep them short and case-insensitive.
fn clip(key: &str) -> String {
    key.chars().take(120).collect::<String>().to_lowercase()
}

/// Key for an account identified by what was typed when there's no matching user.
pub fn account_key(scope: &str, typed: &str) -> String {
    format!("{scope}:{}", typed.trim().to_lowercase())
}

/// Key for a client address. IPv6 is grouped by /64: one machine usually owns a whole /64.
pub fn ip_key(scope: &str, ip: IpAddr) -> String {
    match ip {
        IpAddr::V6(v6) if v6.to_ipv4_mapped().is_none() => {
            let s = v6.segments();
            format!("{scope}:{}", Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
        }
        IpAddr::V6(v6) => format!("{scope}:{}", v6.to_ipv4_mapped().expect("mapped")),
        IpAddr::V4(v4) => format!("{scope}:{v4}"),
    }
}

/// The browser's address. Behind a reverse proxy the TCP peer is the proxy (inside Docker: the bridge gateway), so
/// when the peer is a local/private address and TRUST_PROXY is on, the proxy's X-Forwarded-For is used: only its
/// rightmost entry, which the proxy itself appended (anything to the left came from the client and can be forged).
/// X-Real-IP is ignored: some proxies pass a client-supplied one straight through.
pub fn client_ip(peer: SocketAddr, headers: &HeaderMap, trust_proxy: bool) -> IpAddr {
    let peer_ip = canonical(peer.ip());
    if !trust_proxy || !is_local(peer_ip) {
        return peer_ip;
    }
    let last = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|s| parse_ip(s.trim()))
        .last();
    last.map(canonical).unwrap_or(peer_ip)
}

fn parse_ip(s: &str) -> Option<IpAddr> {
    s.parse::<IpAddr>()
        .ok()
        .or_else(|| s.parse::<SocketAddr>().ok().map(|a| a.ip()))
        .or_else(|| s.trim_start_matches('[').split(']').next().and_then(|x| x.parse().ok()))
}

fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

/// Loopback, private (RFC 1918), CGNAT/Tailscale, link-local, or IPv6 unique-local: where a reverse proxy would be.
fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || (o[0] == 100 && (o[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn h(xff: &[&str]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for v in xff {
            m.append("x-forwarded-for", HeaderValue::from_str(v).unwrap());
        }
        m
    }
    const DOCKER_GW: &str = "172.18.0.1:40000";

    #[test]
    fn behind_a_proxy_the_rightmost_forwarded_address_counts() {
        let peer: SocketAddr = DOCKER_GW.parse().unwrap();
        assert_eq!(client_ip(peer, &h(&["203.0.113.9"]), true).to_string(), "203.0.113.9");
        // a client that sends its own X-Forwarded-For can't choose its address: the proxy appends the real one
        assert_eq!(client_ip(peer, &h(&["1.2.3.4, 203.0.113.9"]), true).to_string(), "203.0.113.9");
        assert_eq!(client_ip(peer, &h(&["1.2.3.4", "203.0.113.9"]), true).to_string(), "203.0.113.9");
        assert_eq!(client_ip(peer, &h(&["2001:db8::7"]), true).to_string(), "2001:db8::7");
        // no header: the peer itself
        assert_eq!(client_ip(peer, &h(&[]), true).to_string(), "172.18.0.1");
        // garbage is ignored
        assert_eq!(client_ip(peer, &h(&["not-an-ip"]), true).to_string(), "172.18.0.1");
    }

    #[test]
    fn exposed_directly_the_header_is_ignored() {
        let public: SocketAddr = "198.51.100.4:5000".parse().unwrap();
        assert_eq!(client_ip(public, &h(&["1.2.3.4"]), true).to_string(), "198.51.100.4");
        let local: SocketAddr = DOCKER_GW.parse().unwrap();
        assert_eq!(client_ip(local, &h(&["1.2.3.4"]), false).to_string(), "172.18.0.1");
        let mapped: SocketAddr = "[::ffff:198.51.100.4]:5000".parse().unwrap();
        assert_eq!(client_ip(mapped, &h(&["1.2.3.4"]), true).to_string(), "198.51.100.4");
    }

    #[test]
    fn ipv6_is_grouped_by_64() {
        let a = ip_key("x", "2001:db8:1:2:aaaa::1".parse().unwrap());
        let b = ip_key("x", "2001:db8:1:2:bbbb::9".parse().unwrap());
        assert_eq!(a, b);
        assert_ne!(a, ip_key("x", "2001:db8:1:3::1".parse().unwrap()));
    }

    #[test]
    fn limits_and_clears() {
        let l = Limiter::new();
        let r = Rule { limit: 3, window: Duration::from_secs(60) };
        for _ in 0..3 {
            assert!(l.check("k", r).is_ok());
            l.hit("K", r); // keys are case-insensitive
        }
        assert!(matches!(l.check("k", r), Err(AppError::TooManyRequests(s)) if s > 0 && s <= 60));
        assert!(l.check("other", r).is_ok());
        l.clear("k");
        assert!(l.check("k", r).is_ok());
    }

    #[test]
    fn window_slides() {
        let l = Limiter::new();
        let r = Rule { limit: 2, window: Duration::from_millis(50) };
        l.hit("k", r);
        l.hit("k", r);
        assert!(l.check("k", r).is_err());
        std::thread::sleep(Duration::from_millis(60));
        assert!(l.check("k", r).is_ok());
    }
}
