import { randomBytes } from "node:crypto";

// Minimal ULID implementation (Crockford Base32).
// Not monotonic; sufficient for unique run/memory ids in this repo.
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(value: bigint, length: number): string {
  let out = "";
  let v = value;
  for (let i = 0; i < length; i++) {
    const idx = Number(v & 31n);
    out = ENCODING[idx]! + out;
    v >>= 5n;
  }
  return out;
}

export function ulid(nowMs: number = Date.now()): string {
  // 48-bit time + 80-bit randomness.
  const time = BigInt(nowMs) & ((1n << 48n) - 1n);
  const rand = randomBytes(10);
  let randBig = 0n;
  for (const b of rand) randBig = (randBig << 8n) | BigInt(b);
  return `${encodeBase32(time, 10)}${encodeBase32(randBig, 16)}`;
}

