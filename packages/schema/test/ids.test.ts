/**
 * ID 的尺子。
 *
 * 每条用例都对应一种**真实会写错的方式**：ID 是回填不了的东西（ADR-0007），
 * 所以"什么样的 ID 才算数"必须被固定下来，而不是靠印象判断。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ID_PREFIXES,
  assetDirOf,
  confirmWithinDays,
  contentAddressedId,
  isAssetId,
  isSourceId,
  mintAssetId,
  mintUlid,
  normalizeId,
  parseAssetId,
  prefixOf,
  typeOfId,
} from "../src/index.ts";

test("内容寻址 ID：同一份内容永远得到同一个 ID（ADR-0013 的全部意义）", () => {
  const a = contentAddressedId("src_", "同样的字节");
  const b = contentAddressedId("src_", "同样的字节");
  assert.equal(a, b);
  assert.equal(a.length, "src_".length + 26);

  const different = contentAddressedId("src_", "换一个字节");
  assert.notEqual(a, different);
});

test("内容寻址 ID：seed 拼接必须有分隔，否则会撞车", () => {
  // 这正是 `eventId` 里 `${source} ${key} ${text}` 三个空格的理由。
  const withoutSeparator = contentAddressedId("event_", `ab${"c"}`);
  const otherPairing = contentAddressedId("event_", `a${"bc"}`);
  assert.equal(withoutSeparator, otherPairing, "不加分隔符时 (ab,c) 与 (a,bc) 本来就该相等——这就是要加分隔符的原因");
});

test("ULID：26 字符，时间在前、随机在后", () => {
  const random = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const early = mintUlid(1_700_000_000_000, random);
  const late = mintUlid(1_800_000_000_000, random);
  assert.equal(early.length, 26);
  assert.equal(late.length, 26);
  // 前 10 字符是时间：晚的一定排在后面（这是 ADR-0007 选 ULID 的理由）。
  assert.ok(early.slice(0, 10) < late.slice(0, 10));
  // 随机段相同则后缀相同——随机性由调用方注入，测试才是确定的。
  assert.equal(early.slice(10), late.slice(10));
});

test("mintAssetId：前缀来自分类法，不在调用点硬编码", () => {
  const id = mintAssetId("decision", 1_700_000_000_000, new Uint8Array(10));
  assert.ok(id.startsWith("dec_"));
  assert.equal(typeOfId(id), "decision");
});

test("解析：前缀与类型一一对应", () => {
  for (const [type, prefix] of Object.entries(ID_PREFIXES)) {
    assert.equal(prefixOf(type as keyof typeof ID_PREFIXES), prefix);
  }
  assert.equal(assetDirOf("decision"), "dec");
  assert.equal(confirmWithinDays("state"), 30);
  assert.equal(confirmWithinDays("event"), null);
});

test("解析：拒绝不合法的 ID（每一种都对应一个真实的写错方式）", () => {
  const bad = [
    "",
    "dec_",
    "dec_abc",
    "decision_01M6Q2FD002MW3PYGNRES1PGRW",
    "dec_01M6Q2FD002MW3PYGNRES1PGR!", // 非法字符
    "dec_01M6Q2FD002MW3PYGNRES1PGRWX", // 27 位
  ];
  for (const id of bad) {
    assert.equal(isAssetId(id), false, `本应拒绝：${id}`);
  }
  assert.equal(isAssetId("dec_01M6Q2FD002MW3PYGNRES1PGRW"), true);
});

test("归一化：大小写与手抄歧义（I/L→1、O→0）指向同一个 ID", () => {
  const canonical = parseAssetId("dec_01M6Q2FD002MW3PYGNRES1PGRW");
  assert.ok(canonical !== null);
  const messy = "DEC_01M6Q2FD002MW3PYGNRES1PGRW".toLowerCase();
  assert.equal(normalizeId(messy), normalizeId("dec_01M6Q2FD002MW3PYGNRES1PGRW"));

  // 真实事故形态：手抄把 1 写成 I、0 写成 O。
  assert.equal(
    normalizeId("dec_01M6Q2FD002MW3PYGNRESIPGRW"),
    normalizeId("dec_01M6Q2FD002MW3PYGNRES1PGRW"),
  );
});

test("来源 ID：形状一样但前缀不同，且不属于任何资产类型", () => {
  const id = contentAddressedId("src_", "raw bytes");
  assert.equal(isSourceId(id), true);
  assert.equal(isAssetId(id), false);
  assert.equal(typeOfId(id), null);
  assert.equal(normalizeId(id), id);
});

test("typeOfId：前缀与 type 不一致是可以被判红的", () => {
  // `state_` 开头的 ID 解析出来必须是 state —— 这正是 ID_PREFIX_MISMATCH 的判据。
  assert.equal(typeOfId("state_01M6Q2FD002MW3PYGNRES1PGRW"), "state");
  assert.equal(typeOfId("rule_01M6Q2FD002MW3PYGNRES1PGRW"), "rule");
});
