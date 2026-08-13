import { useCallback, useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { getCheckinAdmin, saveMediaBuyer, toggleMediaBuyer } from "@/lib/api/checkin";
import type { CheckinAdminView } from "@/server/fns/checkin";

/**
 * The current media buyers, offered by name so binding never means pasting a UUID. This list is a
 * convenience only — membership in `media_buyers` is what makes someone a media buyer, so a third
 * buyer is added through "Other…" below rather than by editing this constant and deploying.
 */
const KNOWN_BUYERS = [
  { personId: "254d872b-594c-8154-9479-000271904e5b", displayName: "Shikhar Gupta" },
  { personId: "2cbd872b-594c-8119-9649-0002845d8d9c", displayName: "Vladyslav Istrati" },
];

/** Sentinel for the buyer dropdown's escape hatch; never a real Notion person id. */
const OTHER = "__other__";

export function MediaBuyerPanel() {
  const [data, setData] = useState<CheckinAdminView | null>(null);
  const [personId, setPersonId] = useState(KNOWN_BUYERS[0].personId);
  const [otherId, setOtherId] = useState("");
  const [otherName, setOtherName] = useState("");
  // null = untouched, so the chat select mirrors whatever is stored for the selected buyer. Without
  // this, picking an already-bound buyer and pressing Bind would silently unbind them.
  const [chatChoice, setChatChoice] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setData(await getCheckinAdmin());
      setLoadError(null);
    } catch (e) {
      // A rejection here is routine — the DB is behind an ssh tunnel — and must not become an
      // unhandled rejection that takes the rest of the Settings page down with it.
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const buyers = data?.buyers ?? [];
  const isOther = personId === OTHER;
  // Known buyers first, then anyone already in the table who is not one of them, so an added third
  // buyer stays re-bindable by name once they exist.
  const options = [
    ...KNOWN_BUYERS,
    ...buyers
      .filter((b) => !KNOWN_BUYERS.some((k) => k.personId === b.personId))
      .map((b) => ({ personId: b.personId, displayName: b.displayName })),
  ];
  const selectedId = isOther ? otherId.trim() : personId;
  const stored = buyers.find((b) => b.personId === selectedId) ?? null;
  const chatId = chatChoice ?? stored?.chatId ?? "";
  // What pressing the button will actually do, so its label and its confirmation cannot disagree.
  const action = chatId ? "bind" : stored?.chatId ? "unbind" : "add";
  const nameFor = (id: string) =>
    buyers.find((b) => b.personId === id)?.displayName ??
    options.find((o) => o.personId === id)?.displayName ??
    id;

  const pickBuyer = (id: string) => {
    setPersonId(id);
    setChatChoice(null); // re-derive from the newly selected buyer's stored binding
    setMsg(null);
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await saveMediaBuyer({
        data: {
          personId: selectedId,
          displayName: isOther ? otherName.trim() : nameFor(selectedId),
          chatId,
        },
      });
      setMsg(
        !res.ok
          ? (res.error ?? "Failed.")
          : action === "bind"
            ? "Bound."
            : action === "unbind"
              ? "Unbound — prompts are still recorded, just undeliverable."
              : "Added. Bind a chat to deliver their prompts.",
      );
      if (res.ok) setChatChoice(null);
    } catch (e) {
      setMsg(`Bind failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const toggle = async (id: string, active: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await toggleMediaBuyer({ data: { personId: id, active } });
      if (!res.ok) setMsg(res.error ?? "Failed.");
    } catch (e) {
      setMsg(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      await reload();
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="size-9 rounded-md bg-primary/10 grid place-items-center">
          <MessageSquare className="size-4 text-primary" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold">Daily check-in · media buyers</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Prompts go out at 17:00 Europe/Berlin to the buyers bound here, matched to the Notion
            board's Owners by person id. Anyone not listed is never prompted.
          </p>
        </div>
      </div>

      {data === null ? (
        loadError === null ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          // Never fall through to the normal body on a failed first load. "Bound buyers (0)" is
          // indistinguishable from a genuinely empty table, so a dropped tunnel or a missing relation
          // would read as "nobody is a media buyer" — the one wrong answer this panel must not give.
          <div className="space-y-2">
            <p className="text-xs text-destructive">
              Could not read the check-in tables, so the current bindings are unknown — which is not
              the same as "no buyers bound". The rest of this page is unaffected.
            </p>
            <p className="text-[11px] font-mono text-muted-foreground break-all">{loadError}</p>
            <button
              onClick={() => void reload()}
              className="h-9 px-4 rounded-md border border-border text-xs font-medium"
            >
              Retry
            </button>
          </div>
        )
      ) : (
        <>
          {loadError !== null && (
            <p className="text-xs text-destructive">
              Showing the last successful read — refreshing it failed: {loadError}
            </p>
          )}

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Media buyer
              </span>
              <select
                value={personId}
                onChange={(e) => pickBuyer(e.target.value)}
                className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-xs font-mono"
              >
                {options.map((o) => (
                  <option key={o.personId} value={o.personId}>
                    {o.displayName}
                  </option>
                ))}
                <option value={OTHER}>Other… (paste a Notion person id)</option>
              </select>
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Telegram chat
              </span>
              <select
                value={chatId}
                onChange={(e) => setChatChoice(e.target.value)}
                className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-xs font-mono"
              >
                <option value="">— unbound —</option>
                {data.chats.map((c) => (
                  <option key={c.chatId} value={c.chatId}>
                    {c.firstName ?? c.username ?? c.chatId} ({c.chatId})
                  </option>
                ))}
                {/* A chat bound before the bot re-discovered it would otherwise vanish from the list
                    and silently reset this select to "unbound". */}
                {chatId && !data.chats.some((c) => c.chatId === chatId) && (
                  <option value={chatId}>{chatId} (not seen recently)</option>
                )}
              </select>
            </label>
            {isOther && (
              <>
                <Input label="Notion person id" value={otherId} onChange={setOtherId} />
                <Input label="Display name" value={otherName} onChange={setOtherName} />
              </>
            )}
          </div>

          {data.chats.length === 0 && (
            <p className="text-xs text-amber-500">
              {data.botConfigured
                ? "No Telegram chats discovered yet — this dropdown fills itself. Each buyer must send /start to the bot once; the bot records their chat id at that moment and it appears here on the next reload. Until then you can only add them unbound."
                : "TELEGRAM_BOT_TOKEN is not set, so the bot cannot receive /start and no chat will ever appear here. Set it in the environment and restart the service."}
            </p>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => void save()}
              disabled={busy || !selectedId || (isOther && !otherName.trim())}
              className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50"
            >
              {action === "bind" ? "Bind" : action === "unbind" ? "Unbind" : "Add as buyer"}
            </button>
            <span className="text-xs text-muted-foreground">
              {msg ??
                "Membership is what makes someone a media buyer; an unbound one still gets prompts recorded, they just cannot be delivered."}
            </span>
          </div>

          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase text-muted-foreground">
              Media buyers ({buyers.length})
            </div>
            {buyers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No media buyers yet — nobody will be prompted. Pick a buyer above and add them.
              </p>
            ) : (
              <div className="rounded-md border border-border divide-y divide-border">
                {buyers.map((b) => (
                  <div key={b.personId} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                    <span className={`font-medium ${b.active ? "" : "text-muted-foreground"}`}>
                      {b.displayName}
                    </span>
                    <span className="flex-1 font-mono text-muted-foreground truncate">
                      {b.chatId ?? "no chat bound"}
                      {b.boundBy ? ` · by ${b.boundBy}` : ""}
                    </span>
                    <button
                      onClick={() => void toggle(b.personId, !b.active)}
                      disabled={busy}
                      className={`shrink-0 rounded border px-2 py-0.5 font-medium disabled:opacity-50 ${
                        b.active
                          ? "border-success/40 text-success"
                          : "border-border text-muted-foreground"
                      }`}
                    >
                      {b.active ? "active" : "inactive"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {data.recentPrompts.length > 0 && (
            <div className="space-y-1 border-t border-border pt-3">
              <div className="text-[11px] font-medium uppercase text-muted-foreground">
                Recent prompts
              </div>
              <div className="max-h-64 overflow-auto rounded-md border border-border divide-y divide-border">
                {data.recentPrompts.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                    <span className="shrink-0 font-mono text-muted-foreground/60">
                      {p.promptDate}
                    </span>
                    <span className="w-48 shrink-0 truncate">{p.campaignTitle}</span>
                    <span className="w-32 shrink-0 truncate text-muted-foreground">
                      {nameFor(p.buyerPersonId)}
                    </span>
                    <span className="w-36 shrink-0 truncate text-muted-foreground">{p.status}</span>
                    <span className="shrink-0">{p.state}</span>
                    {p.note && <span className="flex-1 truncate text-destructive">{p.note}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Input({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-9 rounded-md border border-border bg-background px-3 text-xs font-mono"
      />
    </label>
  );
}
