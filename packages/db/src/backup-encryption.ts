import { createCipheriv, createDecipheriv, randomBytes, type DecipherGCM } from "node:crypto";
import { Transform } from "node:stream";

/**
 * Streaming AES-256-GCM for database backup files. Mirrors the scheme used by
 * the server's local_encrypted secret provider (aes-256-gcm, random 12-byte IV,
 * 16-byte auth tag) but operates on a stream so multi-gigabyte dumps never have
 * to be buffered whole.
 *
 * On-disk layout: MAGIC(8) || IV(12) || ciphertext || TAG(16)
 *
 * The tag is produced only after the final block, so the decrypt transform
 * holds back the trailing 16 bytes until flush. Encrypted backups keep the same
 * .sql[.gz] base name with a trailing ".enc" so the restore path can detect them
 * by extension.
 */
const MAGIC = Buffer.from("PCBKENC1", "utf8"); // 8 bytes
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + IV_LEN;
const ALGO = "aes-256-gcm";

export const ENCRYPTED_BACKUP_EXTENSION = ".enc";

export function isEncryptedBackupFile(fileName: string): boolean {
  return fileName.endsWith(ENCRYPTED_BACKUP_EXTENSION);
}

/**
 * Decode a 32-byte key from a base64 (44-char), hex (64-char) or raw (32-char)
 * string. Returns null when the material does not decode to exactly 32 bytes,
 * matching the secret provider's master-key parsing.
 */
export function decodeBackupKey(raw: string | undefined | null): Buffer | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // fall through to raw handling
  }

  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }
  return null;
}

export function createBackupEncryptStream(key: Buffer): Transform {
  if (key.length !== 32) throw new Error("Backup encryption key must be 32 bytes");
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  let headerWritten = false;
  const writeHeader = (stream: Transform) => {
    if (headerWritten) return;
    stream.push(Buffer.concat([MAGIC, iv]));
    headerWritten = true;
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        writeHeader(this);
        cb(null, cipher.update(chunk as Buffer));
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        writeHeader(this);
        const final = cipher.final();
        const tag = cipher.getAuthTag();
        this.push(Buffer.concat([final, tag]));
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

export function createBackupDecryptStream(key: Buffer): Transform {
  if (key.length !== 32) throw new Error("Backup encryption key must be 32 bytes");
  let header = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  // Always hold back the trailing TAG_LEN bytes — they are the auth tag, not
  // ciphertext, and are only known to be the tail once the stream ends.
  let pending = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        let data = chunk as Buffer;
        if (!decipher) {
          header = Buffer.concat([header, data]);
          if (header.length < HEADER_LEN) return cb();
          if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
            return cb(new Error("Invalid encrypted backup header (bad magic)"));
          }
          const iv = header.subarray(MAGIC.length, HEADER_LEN);
          decipher = createDecipheriv(ALGO, key, iv);
          data = header.subarray(HEADER_LEN);
          header = Buffer.alloc(0);
        }
        pending = Buffer.concat([pending, data]);
        if (pending.length > TAG_LEN) {
          const consumable = pending.subarray(0, pending.length - TAG_LEN);
          pending = pending.subarray(pending.length - TAG_LEN);
          this.push(decipher.update(consumable));
        }
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb) {
      try {
        if (!decipher) return cb(new Error("Encrypted backup ended before its header was read"));
        if (pending.length !== TAG_LEN) {
          return cb(new Error("Encrypted backup is truncated (missing auth tag)"));
        }
        decipher.setAuthTag(pending);
        this.push(decipher.final());
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}
