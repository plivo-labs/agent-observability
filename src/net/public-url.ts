/**
 * SSRF guard for user-supplied outbound URLs (alert webhooks).
 *
 * A rule's webhook_url is attacker-controllable, and the server fetches it
 * directly — so without a guard it can be pointed at loopback, an RFC1918
 * private range, or the cloud metadata endpoint (169.254.169.254) to probe or
 * exfiltrate from internal infrastructure. `assertPublicUrl` rejects any URL
 * that isn't plain http(s) to a public address. Hostnames are resolved (all A/
 * AAAA records) and every resolved address is checked, so a name that maps to a
 * private IP is caught too. Call it before persisting a rule AND immediately
 * before every fetch (defence in depth: DNS can change between the two).
 */
import { lookup } from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

/** Resolve a hostname to its IP addresses. Injectable so tests exercise the
 *  real resolve→block path with a fake resolver (no network). Returns the list
 *  of resolved IP strings. NO NODE_ENV fork here: an env value must never be
 *  able to disable a security check in a deployed artifact — tests that need a
 *  fake resolver inject one via __setResolverForTest. */
export type HostResolver = (host: string) => Promise<string[]>;

let resolver: HostResolver = async (host) => {
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
};

/** Test hook: swap the DNS resolver. Returns a restore function. */
export function __setResolverForTest(fn: HostResolver): () => void {
  const prev = resolver;
  resolver = fn;
  return () => {
    resolver = prev;
  };
}

/** Parse a dotted-quad IPv4 into its 32-bit unsigned value, or null if malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  const inRange = (base: string, maskBits: number) => {
    const baseInt = ipv4ToInt(base)!;
    const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
    return (n & mask) === (baseInt & mask);
  };
  return (
    inRange("0.0.0.0", 8) || // "this" network / unspecified
    inRange("10.0.0.0", 8) || // private
    inRange("100.64.0.0", 10) || // carrier-grade NAT
    inRange("127.0.0.0", 8) || // loopback
    inRange("169.254.0.0", 16) || // link-local (incl. 169.254.169.254 metadata)
    inRange("172.16.0.0", 12) || // private
    inRange("192.168.0.0", 16) || // private
    inRange("192.0.0.0", 24) || // IETF protocol assignments
    inRange("198.18.0.0", 15) || // benchmarking
    inRange("224.0.0.0", 4) || // multicast
    inRange("240.0.0.0", 4) // reserved
  );
}

/** Expand an IPv6 string into its 8 16-bit groups, resolving `::` and a dotted
 *  IPv4 tail (`::ffff:1.2.3.4`). Returns null if malformed. */
function ipv6Groups(addr: string): number[] | null {
  let head = addr;
  // Dotted IPv4 tail → two trailing hex groups.
  const dotted = addr.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[2]);
    if (v4 === null) return null;
    head = `${dotted[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = parse(halves[0]);
  const right = halves.length === 2 ? parse(halves[1]) : [];
  if (left === null || right === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]; // strip any zone id
  const groups = ipv6Groups(addr);
  if (!groups) return true; // unparseable → treat as unsafe
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (groups.every((g) => g === 0)) return true; // :: unspecified
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) return true; // ::1 loopback
  // IPv4-mapped ::ffff:a.b.c.d — check the embedded v4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4(`${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`);
  }
  // NAT64 64:ff9b::/96 — the last 32 bits embed an IPv4 (e.g. 64:ff9b::a9fe:a9fe
  // re-encodes the 169.254.169.254 metadata endpoint on NAT64 networks).
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(`${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`);
  }
  return (
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10 (fe80–febf, mask not string prefix)
    (g0 & 0xffc0) === 0xfec0 || // site-local fec0::/10 (deprecated but routable internally)
    (g0 & 0xfe00) === 0xfc00 // unique-local fc00::/7
  );
}

function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true; // not a recognizable IP → unsafe
}

// ── operator allowlist (WEBHOOK_URL_ALLOWLIST) ──────────────────────────────────
// Explicit opt-in for legitimately-internal webhook receivers (the pre-guard behavior
// delivered anywhere). Comma-separated entries: an exact hostname ("hooks.internal.corp"),
// an IP literal ("10.1.2.3"), or an IPv4 CIDR ("10.1.0.0/16"). Empty (the default) = the
// strict guard applies to everything. Parsed per call — the list is tiny and this keeps
// test/config reloads coherent.
interface AllowRule {
  host?: string;
  ip?: string;
  cidr?: { base: number; maskBits: number };
}

function parseAllowlist(raw: string): AllowRule[] {
  const rules: AllowRule[] = [];
  for (const entry of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const cidr = entry.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
    if (cidr && ipv4ToInt(cidr[1]) !== null && Number(cidr[2]) <= 32) {
      rules.push({ cidr: { base: ipv4ToInt(cidr[1])!, maskBits: Number(cidr[2]) } });
    } else if (net.isIP(entry)) {
      rules.push({ ip: entry });
    } else {
      rules.push({ host: entry });
    }
  }
  return rules;
}

function isAllowlisted(host: string, addresses: string[], rules: AllowRule[]): boolean {
  if (rules.length === 0) return false;
  const hostLower = host.toLowerCase();
  for (const rule of rules) {
    if (rule.host && rule.host === hostLower) return true;
    if (rule.ip && addresses.some((a) => a.toLowerCase() === rule.ip)) return true;
    if (rule.cidr) {
      const { base, maskBits } = rule.cidr;
      const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
      if (addresses.some((a) => {
        const n = ipv4ToInt(a);
        return n !== null && (n & mask) === (base & mask);
      })) {
        return true;
      }
    }
  }
  return false;
}

export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`unsupported URL scheme "${url.protocol}" (only http/https allowed)`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolver(host);
    } catch {
      throw new SsrfError(`could not resolve host "${host}"`);
    }
    if (addresses.length === 0) throw new SsrfError(`host "${host}" resolved to no addresses`);
  }

  // Operator opt-in escape hatch for known-internal receivers (see parseAllowlist).
  const allowRules = parseAllowlist(config.WEBHOOK_URL_ALLOWLIST ?? "");
  if (isAllowlisted(host, addresses, allowRules)) return;

  // The block loop ALWAYS runs — an IP literal is checked directly, a hostname is
  // resolved (via the injectable `resolver`) and every returned address checked.
  for (const addr of addresses) {
    if (isBlockedAddress(addr)) {
      throw new SsrfError(`host "${host}" resolves to a non-public address (${addr})`);
    }
  }
}
