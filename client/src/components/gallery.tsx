import { useState } from "react";
import { fileUrl } from "@/lib/api";

type Img = { path?: string; src?: string; caption?: string | null };
const srcOf = (i: Img) => i.src ?? fileUrl(i.path) ?? "";

/** Photo with a graceful fallback when the file is missing. */
export function Photo({ src, alt, className = "", fit = "cover" }: { src: string; alt: string; className?: string; fit?: "cover" | "contain" }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <div className={`grid place-items-center bg-gradient-to-br from-ink-800 via-ink-700 to-gold-700 ${className}`}><span className="px-3 text-center font-display text-xl font-semibold text-white/80">{alt}</span></div>;
  return <img src={src} alt={alt} className={`${fit === "contain" ? "object-contain" : "object-cover"} ${className}`} loading="lazy" onError={() => setBroken(true)} />;
}

/** Main photo with swipeable thumbnails. */
export function Gallery({ images, alt, height = "h-64 sm:h-80" }: { images: Img[]; alt: string; height?: string }) {
  const [i, setI] = useState(0);
  if (!images.length) return <Photo src="" alt={alt} className={`w-full rounded-xl ${height}`} />;
  const cur = images[Math.min(i, images.length - 1)];
  return (
    <div>
      <div className="relative overflow-hidden rounded-xl bg-ink-900">
        <img src={srcOf(cur)} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-xl" />
        <Photo src={srcOf(cur)} alt={cur.caption || alt} fit="contain" className={`relative w-full ${height}`} />
        {images.length > 1 && <>
          <button type="button" aria-label="Previous photo" onClick={() => setI((i - 1 + images.length) % images.length)} className="absolute left-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white hover:bg-black/65">‹</button>
          <button type="button" aria-label="Next photo" onClick={() => setI((i + 1) % images.length)} className="absolute right-2 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white hover:bg-black/65">›</button>
          <span className="absolute bottom-2 right-2 rounded-full bg-black/50 px-2 py-0.5 text-xs text-white">{i + 1} / {images.length}</span>
        </>}
        {cur.caption && <span className="absolute bottom-2 left-2 rounded bg-black/50 px-2 py-0.5 text-xs text-white">{cur.caption}</span>}
      </div>
      {images.length > 1 && (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {images.map((im, k) => (
            <button key={k} type="button" onClick={() => setI(k)} className={`shrink-0 overflow-hidden rounded-md border-2 ${k === i ? "border-gold-500" : "border-transparent opacity-80"}`}>
              <Photo src={srcOf(im)} alt="" className="h-14 w-20" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Photos of the building (static files in client/public/images/site). */
export const SITE_PHOTOS = [
  { src: "/images/site/outside-day.jpg", caption: "The building by day" },
  { src: "/images/site/outside-night.jpg", caption: "The building at night" },
  { src: "/images/site/hallway.jpg", caption: "Hallway" },
  { src: "/images/site/stairway.jpg", caption: "Stairway" },
];
