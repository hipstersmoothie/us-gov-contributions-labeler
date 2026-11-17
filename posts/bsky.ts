// Making a post: the link card from the page's own og: tags and preview image,
// mention facets, and the record itself.
import { AppBskyRichtextFacet, AtpAgent, RichText } from "@atproto/api";

/** Bluesky's limit for a link card's thumbnail. */
const MAX_THUMB_BYTES = 1_000_000;

export interface Page {
  url: string;
  title: string;
  description: string;
  image?: string;
}

const decode = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function meta(html: string, property: string) {
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    if (!new RegExp(`(property|name)="${property}"`, "i").test(tag)) continue;
    const content = tag.match(/content="([^"]*)"/i)?.[1];
    if (content !== undefined) return decode(content);
  }
  return undefined;
}

/**
 * The page a post links to, as its link card would show it. Throws if the
 * page isn't there, or doesn't yet say `expect` (the site hasn't deployed
 * the data the post is about).
 */
export async function fetchPage(url: string, expect?: string): Promise<Page> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const html = await res.text();
  if (expect && !html.includes(expect)) throw new Error(`${url} doesn't say "${expect}" yet`);
  const title = meta(html, "og:title");
  if (!title) throw new Error(`${url}: no og:title`);
  return { url, title, description: meta(html, "og:description") ?? "", image: meta(html, "og:image") };
}

/** Mention and link facets; every @handle in the text has to be in `mentions`. */
export function facets(text: string, mentions: Record<string, string> = {}) {
  const rt = new RichText({ text });
  rt.detectFacetsWithoutResolution();
  const out = (rt.facets ?? []).map((f) => ({
    ...f,
    features: f.features.map((x) => (AppBskyRichtextFacet.isMention(x) ? { ...x, did: mentions[x.did] ?? x.did } : x)),
  }));
  for (const f of out) for (const x of f.features) if (AppBskyRichtextFacet.isMention(x) && !x.did.startsWith("did:")) throw new Error(`Unresolved mention @${x.did}`);
  return out;
}

export class Poster {
  private agent: AtpAgent;
  private loggedIn = false;
  constructor(
    private identifier: string,
    private password: string,
    service = "https://bsky.social"
  ) {
    this.agent = new AtpAgent({ service });
  }

  private async login() {
    if (this.loggedIn) return;
    await this.agent.login({ identifier: this.identifier, password: this.password });
    this.loggedIn = true;
  }

  private async thumb(image: string | undefined) {
    if (!image) return undefined;
    try {
      const res = await fetch(image);
      if (!res.ok) throw new Error(`${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_THUMB_BYTES) throw new Error(`${bytes.length} bytes`);
      const { data } = await this.agent.uploadBlob(bytes, { encoding: res.headers.get("content-type") ?? "image/png" });
      return data.blob;
    } catch (err) {
      // A card without a picture is better than no post.
      console.error(`Thumbnail ${image} failed:`, err);
      return undefined;
    }
  }

  /** Post with a link card for `page`. Returns the new post's at-uri. */
  async post(text: string, page: Page, mentions?: Record<string, string>) {
    await this.login();
    try {
      const thumb = await this.thumb(page.image);
      const res = await this.agent.post({
        text,
        facets: facets(text, mentions),
        langs: ["en"],
        embed: {
          $type: "app.bsky.embed.external",
          external: { uri: page.url, title: page.title, description: page.description, ...(thumb && { thumb }) },
        },
        createdAt: new Date().toISOString(),
      });
      return res.uri;
    } catch (err) {
      // An expired session gets a fresh login on the next try.
      if ((err as { status?: number }).status === 401) this.loggedIn = false;
      throw err;
    }
  }
}
