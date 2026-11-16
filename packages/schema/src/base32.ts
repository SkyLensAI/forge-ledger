/**
 * Crockford base32 —— ID 的字符层（ADR-0007）。
 *
 * 字符表刻意不含 `I` `L` `O` `U`：
 * - `I`/`L` 与 `1` 手抄时会混，`O` 与 `0` 会混。ID 是要被人抄进 issue、
 *   贴进聊天、念给同事听的，所以"看起来一样"必须等于"就是一样"。
 * - `U` 整个排除，是为了让 ID 里不可能拼出脏词（Crockford 的原始理由）。
 *
 * 解码时把 `I`/`L` 折成 `1`、`O` 折成 `0`（ADR-0007 的"先做归一化再比较"）。
 * 这条不做的话，`supersedes` 这类引用会因为大小写或手抄差异**静默断链**——
 * 而断链是查不出来的：它看起来只是"这条引用指向了一个不存在的 ID"。
 */

/** Crockford base32 字母表（无 I / L / O / U）。 */
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ID 后缀长度：26 字符 = 130 位。 */
export const ID_SUFFIX_LENGTH = 26;

const DECODE: ReadonlyMap<string, number> = new Map(
  [...ALPHABET].map((char, index) => [char, index] as const),
);

/**
 * 把字节按 **MSB 优先**编码成固定长度的 base32 字符串。
 *
 * 位数不够时在末尾补零位（例如 128 位编码成 26 字符 = 130 位，补 2 位）。
 * "固定长度"是刻意的：ID 的长度是协议的一部分，可变长度会让正则和分区逻辑都变复杂，
 * 而省下的那几个字符没有任何人受益。
 *
 * @param {Uint8Array} bytes
 * @param {number} chars
 * @returns {string}
 */
export function encodeBase32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (let produced = 0; produced < chars; produced += 1) {
    while (bits < 5) {
      buffer = (buffer << 8) | (bytes[index] ?? 0);
      index += 1;
      bits += 8;
    }
    const value = (buffer >> (bits - 5)) & 31;
    bits -= 5;
    buffer &= (1 << bits) - 1; // 丢掉已经用掉的位，否则 buffer 会一直左移溢出
    out += ALPHABET[value];
  }
  return out;
}

/**
 * @param {string} text
 * @returns {Uint8Array | null} 含非法字符时返回 null
 */
export function decodeBase32(text: string): Uint8Array | null {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of text) {
    const value = DECODE.get(char);
    if (value === undefined) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * 大小写 + 手抄歧义归一。**比较 ID 之前必须走这一遍**（ADR-0007）。
 *
 * @param {string} text
 * @returns {string | null} 含无法归一的字符时返回 null
 */
export function normalizeBase32(text: string): string | null {
  let out = "";
  for (const raw of text.toUpperCase()) {
    if (DECODE.has(raw)) {
      out += raw;
      continue;
    }
    // 手抄歧义：I/L 看起来像 1，O 看起来像 0。
    if (raw === "I" || raw === "L") {
      out += "1";
      continue;
    }
    if (raw === "O") {
      out += "0";
      continue;
    }
    return null;
  }
  return out;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function isBase32Suffix(text: string): boolean {
  return text.length === ID_SUFFIX_LENGTH && normalizeBase32(text) !== null;
}
