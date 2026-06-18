import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createBackupDecryptStream,
  createBackupEncryptStream,
  decodeBackupKey,
  isEncryptedBackupFile,
} from "./backup-encryption.js";

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function encrypt(key: Buffer, plaintext: Buffer): Promise<Buffer> {
  return collect(Readable.from([plaintext]).pipe(createBackupEncryptStream(key)));
}

async function decrypt(key: Buffer, ciphertext: Buffer): Promise<Buffer> {
  return collect(Readable.from([ciphertext]).pipe(createBackupDecryptStream(key)));
}

describe("backup-encryption", () => {
  const key = randomBytes(32);

  it("round-trips small and large payloads across arbitrary chunk boundaries", async () => {
    for (const size of [0, 1, 15, 16, 17, 1024, 256 * 1024 + 7]) {
      const plaintext = randomBytes(size);
      const ciphertext = await encrypt(key, plaintext);
      // Re-chunk into odd sizes to exercise the streaming tag hold-back.
      const reChunked = new Readable({
        read() {
          let offset = 0;
          while (offset < ciphertext.length) {
            const end = Math.min(offset + 13, ciphertext.length);
            this.push(ciphertext.subarray(offset, end));
            offset = end;
          }
          this.push(null);
        },
      });
      const decrypted = await collect(reChunked.pipe(createBackupDecryptStream(key)));
      expect(decrypted.equals(plaintext)).toBe(true);
    }
  });

  it("rejects ciphertext tampered in the body (GCM auth failure)", async () => {
    const ciphertext = await encrypt(key, Buffer.from("the database lives here"));
    const tampered = Buffer.from(ciphertext);
    tampered[25] ^= 0x01; // flip a bit inside the ciphertext region
    await expect(decrypt(key, tampered)).rejects.toThrow();
  });

  it("rejects decryption under the wrong key", async () => {
    const ciphertext = await encrypt(key, Buffer.from("secret dump"));
    await expect(decrypt(randomBytes(32), ciphertext)).rejects.toThrow();
  });

  it("rejects a truncated tag", async () => {
    const ciphertext = await encrypt(key, Buffer.from("secret dump"));
    await expect(decrypt(key, ciphertext.subarray(0, ciphertext.length - 4))).rejects.toThrow(
      /truncated|auth/i,
    );
  });

  it("decodes 32-byte keys from hex, base64 and raw, rejects others", () => {
    const raw = randomBytes(32);
    expect(decodeBackupKey(raw.toString("hex"))?.equals(raw)).toBe(true);
    expect(decodeBackupKey(raw.toString("base64"))?.equals(raw)).toBe(true);
    expect(decodeBackupKey("0123456789abcdef0123456789abcdef")?.length).toBe(32); // raw 32 chars
    expect(decodeBackupKey("too-short")).toBeNull();
    expect(decodeBackupKey(undefined)).toBeNull();
    expect(decodeBackupKey("")).toBeNull();
  });

  it("detects encrypted backup files by extension", () => {
    expect(isEncryptedBackupFile("paperclip-2026.sql.gz.enc")).toBe(true);
    expect(isEncryptedBackupFile("paperclip-2026.sql.gz")).toBe(false);
  });
});
