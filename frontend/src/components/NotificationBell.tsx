import type { TFunction } from "i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  Archive,
  ArrowRightLeft,
  AtSign,
  Bell,
  CalendarClock,
  CheckCheck,
  CircleDot,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { Popover as RPopover } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "../lib/api";
import { fmtDate, fmtRelative } from "../lib/prefs";
import { avatarUrl } from "../lib/user";
import { ask } from "./dialogs";
import { toastActivity, toastError, toastSuccess } from "./toast";
import { Avatar } from "./ui";

export interface Notification {
  id: number;
  kind:
    | "assigned"
    | "mentioned"
    | "commented"
    | "due_soon"
    | "overdue"
    | "card_created"
    | "card_moved"
    | "status"
    | "card_updated"
    | "attachments"
    | "archived";
  board_id: string;
  board_name: string;
  card_id: string | null;
  card_number: number | null;
  card_title: string | null;
  actor_name: string | null;
  actor_color: string | null;
  actor_avatar: string | null;
  data: {
    snippet?: string;
    due_at?: string;
    to?: string;
    restored?: boolean;
    changes?: { en: string[]; th: string[] };
  };
  created_at: string;
  read_at: string | null;
}

export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () =>
      api.get<{ items: Notification[]; unread: number }>("/notifications"),
    refetchInterval: 5 * 60_000, // safety net; the socket below pushes new ones instantly
  });
}

/** One socket per tab: the server pings when a notification arrives, we refetch and pop a toast. */
function useNotificationSocket() {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const lastSeen = useRef<number | null>(null);
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const connect = () => {
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/notifications/ws`,
      );
      ws.onopen = () => (retry = 0);
      ws.onmessage = async () => {
        await qc.invalidateQueries({ queryKey: ["notifications"] });
        const d = qc.getQueryData<{ items: Notification[] }>(["notifications"]);
        const fresh = (d?.items ?? []).filter(
          (n) =>
            !n.read_at &&
            (lastSeen.current === null || n.id > lastSeen.current),
        );
        if (d?.items[0])
          lastSeen.current = Math.max(lastSeen.current ?? 0, d.items[0].id);
        for (const n of fresh.slice(0, 3).reverse()) {
          toastActivity(
            {
              name: n.actor_name ?? "Kanb",
              color: n.actor_color ?? "#2f5bd3",
              src: avatarUrl(n.actor_avatar),
            },
            describe(t, n, true),
          );
        }
      };
      ws.onclose = () => {
        if (!stopped)
          timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [qc, t]);
  // remember the newest id we already know about, so only genuinely new ones toast
  const { data } = useNotifications();
  useEffect(() => {
    if (lastSeen.current === null && data)
      lastSeen.current = data.items[0]?.id ?? 0;
  }, [data]);
}

type T = TFunction;

/** Sentence for a notification. `withoutActor` when the actor's name is shown separately (toasts). */
function describe(t: T, n: Notification, withoutActor = false) {
  const card = n.card_number
    ? `#${n.card_number} ${n.card_title ?? ""}`.trim()
    : n.board_name;
  const key = n.kind === "archived" && n.data.restored ? "restored" : n.kind;
  const when = n.data.due_at ? fmtDate(n.data.due_at, true) : "";
  const text = t(`notifications.${key}`, { card, to: n.data.to ?? "", when });
  return withoutActor || !n.actor_name ? text : `${n.actor_name} ${text}`;
}

/** Card activity: the individual changes, in the reader's language; other kinds: the quoted text. */
function detail(n: Notification, lang: string) {
  if (n.data.changes)
    return (lang === "th" ? n.data.changes.th : n.data.changes.en).join(" · ");
  return n.data.snippet ? `“${n.data.snippet}”` : "";
}

const ICON = {
  assigned: UserPlus,
  mentioned: AtSign,
  commented: MessageSquare,
  due_soon: CalendarClock,
  overdue: CalendarClock,
  card_created: Plus,
  card_moved: ArrowRightLeft,
  status: CircleDot,
  card_updated: Pencil,
  attachments: Paperclip,
  archived: Archive,
};

export function NotificationBell() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  useNotificationSocket();
  const { data } = useNotifications();
  const read = useMutation({
    mutationFn: (body: { ids?: number[]; all?: boolean }) =>
      api.post("/notifications/read", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const clear = useMutation({
    mutationFn: (body: { ids?: number[]; all?: boolean }) =>
      api.post<{ cleared: number }>("/notifications/clear", body),
    onSuccess: (_r, body) => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
      if (body.all) toastSuccess(t("notifications.cleared"));
    },
    onError: toastError,
  });
  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];
  return (
    <RPopover.Root open={open} onOpenChange={setOpen}>
      <RPopover.Trigger asChild>
        <button
          className="relative rounded-md p-1.5 text-muted hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10 cursor-pointer"
          aria-label={t("notifications.title")}
          title={t("notifications.title")}
        >
          <Bell size={17} />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </RPopover.Trigger>
      <RPopover.Portal>
        <RPopover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 flex max-h-[70dvh] w-[min(400px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl outline-none"
        >
          <div className="flex items-center border-b border-line px-3 py-2">
            <span className="text-sm font-semibold">
              {t("notifications.title")}
            </span>
            <span className="ml-auto flex items-center gap-3">
              {unread > 0 && (
                <button
                  onClick={() => read.mutate({ all: true })}
                  className="flex items-center gap-1 text-xs text-accent hover:underline cursor-pointer"
                >
                  <CheckCheck size={14} /> {t("notifications.markAll")}
                </button>
              )}
              {items.length > 0 && (
                <button
                  onClick={async () => {
                    if (
                      await ask({
                        title: t("notifications.clearTitle"),
                        message: t("notifications.clearMsg"),
                        confirmLabel: t("notifications.clearAll"),
                        danger: true,
                      })
                    )
                      clear.mutate({ all: true });
                  }}
                  disabled={clear.isPending}
                  className="flex items-center gap-1 text-xs text-muted hover:text-red-600 hover:underline cursor-pointer"
                >
                  <Trash2 size={13} /> {t("notifications.clearAll")}
                </button>
              )}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {items.length === 0 && (
              <p className="p-6 text-center text-sm text-muted">
                {t("notifications.empty")}
              </p>
            )}
            {items.map((n) => {
              const Icon = ICON[n.kind] ?? Bell;
              const more = detail(n, i18n.language);
              return (
                <div
                  key={n.id}
                  className="group relative border-b border-line last:border-0"
                >
                  <button
                    onClick={() => {
                      if (!n.read_at) read.mutate({ ids: [n.id] });
                      setOpen(false);
                      nav(
                        n.card_id
                          ? `/b/${n.board_id}?card=${n.card_id}`
                          : `/b/${n.board_id}`,
                      );
                    }}
                    className={clsx(
                      "flex w-full gap-2.5 py-2.5 pl-3 pr-8 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer",
                      !n.read_at && "bg-accent/5",
                    )}
                  >
                    {n.actor_name ? (
                      <Avatar
                        name={n.actor_name}
                        color={n.actor_color ?? "#2f5bd3"}
                        src={avatarUrl(n.actor_avatar)}
                        size={28}
                      />
                    ) : (
                      <span
                        className={clsx(
                          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                          n.kind === "overdue"
                            ? "bg-red-500/15 text-red-600"
                            : "bg-amber-500/15 text-amber-600",
                        )}
                      >
                        <Icon size={15} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block [overflow-wrap:anywhere]">
                        {describe(t, n)}
                      </span>
                      {more && (
                        <span className="mt-0.5 line-clamp-2 block text-xs text-muted [overflow-wrap:anywhere]">
                          {more}
                        </span>
                      )}
                      <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted">
                        <Icon size={11} /> {n.board_name} ·{" "}
                        {fmtRelative(n.created_at)}
                      </span>
                    </span>
                    {!n.read_at && (
                      <span
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent"
                        aria-label={t("notifications.unread")}
                      />
                    )}
                  </button>
                  <button
                    onClick={() => clear.mutate({ ids: [n.id] })}
                    title={t("notifications.dismiss")}
                    aria-label={t("notifications.dismiss")}
                    className="absolute right-1.5 top-2 rounded p-1 text-muted opacity-60 hover:bg-black/5 hover:text-[var(--text)] hover:opacity-100 focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 dark:hover:bg-white/10 cursor-pointer"
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </RPopover.Content>
      </RPopover.Portal>
    </RPopover.Root>
  );
}
