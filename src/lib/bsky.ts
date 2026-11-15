// Unauthenticated helpers for the public Bluesky AppView.
const BASE = "https://public.api.bsky.app/xrpc";

// did:plc for bsky.app, the default trusted verifier.
export const BSKY_VERIFIER = "did:plc:z72i7hdynmk6r22z27h6tvur";

export interface Profile {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  verification?: {
    verifiedStatus?: string;
    verifications?: { issuer: string }[];
  };
}

async function xrpc<T>(
  method: string,
  params: Record<string, string | string[]>
): Promise<T | null> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) qs.append(key, v);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${BASE}/${method}?${qs}`);
    if (res.ok) return (await res.json()) as T;
    // 400s are "not found" style answers (unknown handle, etc.)
    if (res.status === 400) return null;
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`${method} failed: ${res.status} ${await res.text()}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }

  throw new Error(`${method} failed after retries`);
}

export async function resolveHandle(handle: string) {
  const res = await xrpc<{ did: string }>("com.atproto.identity.resolveHandle", {
    handle,
  });
  return res?.did ?? null;
}

export async function getProfiles(actors: string[]) {
  const profiles: Profile[] = [];
  for (let i = 0; i < actors.length; i += 25) {
    const batch = actors.slice(i, i + 25);
    const res = await xrpc<{ profiles: Profile[] }>("app.bsky.actor.getProfiles", {
      actors: batch,
    });
    if (res) {
      profiles.push(...res.profiles);
    } else if (batch.length > 1) {
      // One malformed actor fails the whole batch, so retry individually.
      for (const actor of batch) profiles.push(...(await getProfiles([actor])));
    }
  }
  return profiles;
}

export async function searchActors(q: string, limit = 10) {
  const res = await xrpc<{ actors: Profile[] }>("app.bsky.actor.searchActors", {
    q,
    limit: String(limit),
  });
  return res?.actors ?? [];
}

export async function getListMembers(list: string) {
  const members: Profile[] = [];
  let cursor: string | undefined;
  do {
    const res = await xrpc<{
      items: { subject: Profile }[];
      cursor?: string;
    }>("app.bsky.graph.getList", {
      list,
      limit: "100",
      ...(cursor ? { cursor } : {}),
    });
    members.push(...(res?.items.map((i) => i.subject) ?? []));
    cursor = res?.cursor;
  } while (cursor);
  return members;
}

export function isVerified(profile: Profile) {
  return profile.verification?.verifiedStatus === "valid";
}
