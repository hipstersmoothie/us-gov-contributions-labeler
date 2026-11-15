// Round avatars, as a spaced row (with names on hover and in alt text) or an
// overlapping stack. Rendered server-side from .astro files too (no JS).
import type { Face } from "./types";

const PARTY = { D: "Democrat", R: "Republican", I: "Independent" } as const;
const initials = (name: string) => {
  const parts = name.replace(/,? (Jr\.|Sr\.|II|III|IV)$/, "").split(" ");
  return `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`;
};

export function Avatar({ face, size = 40, alt }: { face: Face; size?: number; alt?: string }) {
  const label = alt ?? `${face.name} (${PARTY[face.party]})`;
  return face.avatar ? (
    <img className={`bsky-avatar party-${face.party}`} src={face.avatar} alt={label} title={alt === "" ? undefined : label} width={size} height={size} loading="lazy" decoding="async" style={{ width: size, height: size }} />
  ) : (
    <span className={`bsky-avatar bsky-initials party-${face.party}`} role={alt === "" ? undefined : "img"} aria-label={alt === "" ? undefined : label} aria-hidden={alt === "" ? true : undefined} title={alt === "" ? undefined : label} style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}>
      {initials(face.name)}
    </span>
  );
}

/** A row of avatars, each linking to the member's page. */
export function FaceRow({ faces, size = 40, more, label = "Members" }: { faces: Face[]; size?: number; more?: { count: number; href: string; label: string }; label?: string }) {
  return (
    <ul className="bsky-facerow" aria-label={label}>
      {faces.map((f) => (
        <li key={f.id ?? f.name}>
          {f.id ? (
            <a href={`/members/${f.id}/`}>
              <Avatar face={f} size={size} />
            </a>
          ) : (
            <Avatar face={f} size={size} />
          )}
        </li>
      ))}
      {more && more.count > 0 && (
        <li>
          <a className="bsky-avatar bsky-more" href={more.href} style={{ width: size, height: size }} aria-label={more.label} title={more.label}>
            +{more.count}
          </a>
        </li>
      )}
    </ul>
  );
}

/** Overlapping avatars; decorative, so the text beside them must say who. */
export function FaceStack({ faces, size = 32 }: { faces: Face[]; size?: number }) {
  return (
    <span className="bsky-stack" aria-hidden="true">
      {faces.map((f) => (
        <Avatar key={f.id ?? f.name} face={f} size={size} alt="" />
      ))}
    </span>
  );
}
