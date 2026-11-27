import { fileUrl } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";

type Msg = { id: string; fromGuest: boolean; senderName: string; body: string; attachmentPath: string | null; readAt: string | null; createdAt: string };

export function MessageThread({ messages, viewer }: { messages: Msg[]; viewer: "guest" | "staff" }) {
  return (
    <ol className="space-y-3">
      {messages.map((m) => {
        const mine = viewer === "guest" ? m.fromGuest : !m.fromGuest;
        return (
          <li key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm shadow-sm ${mine ? "rounded-br-sm bg-ink-900 text-white" : "rounded-bl-sm border border-ink-100 bg-white text-ink-900"}`}>
              <p className={`text-xs font-semibold ${mine ? "text-gold-300" : "text-gold-700"}`}>{m.senderName}</p>
              {m.body && <p className="mt-0.5 whitespace-pre-wrap break-words">{m.body}</p>}
              {m.attachmentPath && <a href={fileUrl(m.attachmentPath)!} target="_blank" rel="noreferrer" className="mt-2 block"><img src={fileUrl(m.attachmentPath)!} alt="Attachment" className="max-h-48 rounded-lg" /></a>}
              <p className={`mt-1 text-[11px] ${mine ? "text-ink-300" : "text-ink-400"}`}>{fmtDateTime(m.createdAt)}{mine && (m.readAt ? " · Read" : " · Sent")}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
