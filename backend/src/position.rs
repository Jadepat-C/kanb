//! Fractional-index ordering keys (base-62, compared bytewise / COLLATE "C").
//! A move only rewrites the moved row: its new key sits between its new neighbours.

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

fn idx(c: u8) -> usize {
    DIGITS.iter().position(|&d| d == c).expect("invalid position digit")
}

/// Returns a key strictly between `a` and `b` (`None` = open end). Keys never end in '0'.
pub fn between(a: Option<&str>, b: Option<&str>) -> String {
    let a = a.unwrap_or("");
    if let Some(b) = b {
        assert!(a < b, "position keys out of order: {a:?} >= {b:?}");
    }
    midpoint(a.as_bytes(), b.map(str::as_bytes))
}

fn midpoint(a: &[u8], b: Option<&[u8]>) -> String {
    if let Some(b) = b {
        // shared prefix (treating missing chars of `a` as '0')
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(b'0') == b[n] {
            n += 1;
        }
        if n > 0 {
            let prefix = String::from_utf8(b[..n].to_vec()).unwrap();
            let rest_a = if n < a.len() { &a[n..] } else { &[][..] };
            return prefix + &midpoint(rest_a, Some(&b[n..]));
        }
    }
    let da = a.first().map(|&c| idx(c)).unwrap_or(0);
    let db = b.and_then(|b| b.first()).map(|&c| idx(c)).unwrap_or(DIGITS.len());
    if db - da > 1 {
        let mid = (da + db).div_ceil(2);
        (DIGITS[mid] as char).to_string()
    } else if let Some(b) = b.filter(|b| b.len() > 1) {
        (b[0] as char).to_string()
    } else {
        let rest = if a.len() > 1 { &a[1..] } else { &[][..] };
        let mut s = (DIGITS[da] as char).to_string();
        s.push_str(&midpoint(rest, None));
        s
    }
}

#[cfg(test)]
mod tests {
    use super::between;

    #[test]
    fn ordering_holds() {
        let first = between(None, None);
        let mut keys = vec![first];
        // append 200 at the end, prepend 200 at the front, insert 200 in the middle
        for _ in 0..200 {
            let k = between(Some(keys.last().unwrap()), None);
            keys.push(k);
        }
        for _ in 0..200 {
            let k = between(None, Some(&keys[0]));
            keys.insert(0, k);
        }
        for _ in 0..200 {
            let m = keys.len() / 2;
            let k = between(Some(&keys[m - 1]), Some(&keys[m]));
            keys.insert(m, k);
        }
        for w in keys.windows(2) {
            assert!(w[0] < w[1], "{} !< {}", w[0], w[1]);
            assert!(!w[1].ends_with('0'));
        }
    }
}
