/**
 * 分类法的**解析与一致性检查**（ADR-0010）。
 *
 * 一致性检查检查的是**漂移**，不是正确性：代码加了码忘了写文档、
 * 文档写了前缀分类法里没有、模板漏了必填项。漂移是这两份表述唯一会犯的错，
 * 而它变成红，比"约定要同步更新"这种自然语言提示强（反模式 2）。
 *
 * 这里只做**不需要读文件**的那部分检查；需要读文件的（模板里有没有那个章节、
 * 违规码有没有在 `schema/provenance.md` 里出现过）由闸门脚本做。
 * 分界线的判据是"这个检查需不需要 IO"，不是"这个检查重不重要"。
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  ASSET_FIELDS,
  ASSET_TYPES,
  FRESHNESS_DAYS,
  ID_PREFIXES,
  LIFECYCLE,
  REQUIRED_FIELDS,
  REQUIRED_SECTIONS,
  SCHEMA_VERSION,
  SOURCE_PREFIX,
  isAssetType,
  type AssetType,
} from "./fields.ts";
import { validate, type ValidationResult } from "./validate.ts";

const AssetTypeSpecSchema = z.object({
  prefix: z.string().min(1),
  lifecycle: z.enum(["append_only", "replace_in_place"]),
  immutable_after: z.string().optional(),
  requires_fields: z.array(z.string()),
  requires_sections: z.array(z.string()),
  freshness: z
    .object({ confirm_within_days: z.number().int().positive(), on_expiry: z.string() })
    .nullable(),
});

const TaxonomySchema = z.object({
  version: z.number().int().positive(),
  asset_types: z.record(z.string(), AssetTypeSpecSchema),
  source_types: z.record(z.string(), z.object({ description: z.string().optional() })),
  fields: z.record(z.string(), z.record(z.string(), z.unknown())),
});

export type AssetTypeSpec = z.infer<typeof AssetTypeSpecSchema>;
export type Taxonomy = z.infer<typeof TaxonomySchema>;

/**
 * @param {string} text `schema/taxonomy.yaml` 的内容
 * @returns {ValidationResult<Taxonomy>}
 */
export function parseTaxonomy(text: string): ValidationResult<Taxonomy> {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: [], message: `不是合法 YAML：${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  return validate(TaxonomySchema, raw);
}

/**
 * 代码侧常量与 YAML 的漂移清单。空数组 = 一致。
 *
 * 每一条检查都对应一种**真实会发生的漂移**，而不是"顺便也查一下"。
 * 多出来的检查会让人学会忽略这张清单——那比少一条检查更糟。
 *
 * @param {Taxonomy} taxonomy
 * @returns {string[]}
 */
export function checkTaxonomyAgainstCode(taxonomy: Taxonomy): string[] {
  const drift: string[] = [];

  if (taxonomy.version !== SCHEMA_VERSION) {
    drift.push(
      `版本号不一致：taxonomy.yaml 是 v${taxonomy.version}，代码常量是 v${SCHEMA_VERSION}` +
        `（ADR-0008：只有一个版本号，两处不同步就没有权威）`,
    );
  }

  const declared = Object.keys(taxonomy.asset_types).sort();
  const known = [...ASSET_TYPES].sort();
  for (const type of known) {
    if (!declared.includes(type)) drift.push(`taxonomy.yaml 缺少类型 ${type}（代码里有）`);
  }
  for (const type of declared) {
    if (!isAssetType(type)) drift.push(`taxonomy.yaml 声明了代码不认识的类型 ${type}`);
  }

  for (const type of ASSET_TYPES) {
    const spec = taxonomy.asset_types[type];
    if (spec === undefined) continue;

    if (spec.prefix !== ID_PREFIXES[type]) {
      drift.push(`${type} 的前缀：taxonomy.yaml 是 ${spec.prefix}，代码是 ${ID_PREFIXES[type]}（前缀改了等于改 ID）`);
    }
    if (spec.lifecycle !== LIFECYCLE[type]) {
      drift.push(`${type} 的 lifecycle：taxonomy.yaml 是 ${spec.lifecycle}，代码是 ${LIFECYCLE[type]}`);
    }
    for (const field of spec.requires_fields) {
      if (!ASSET_FIELDS.includes(field)) {
        drift.push(`${type}.requires_fields 里的 ${field} 不是已知字段（字段全集在 ASSET_FIELDS）`);
      }
    }
    const specFields = [...spec.requires_fields].sort().join(",");
    const codeFields = [...REQUIRED_FIELDS[type]].sort().join(",");
    if (specFields !== codeFields) {
      drift.push(`${type}.requires_fields：taxonomy.yaml 是 [${specFields}]，代码是 [${codeFields}]`);
    }
    const specSections = [...spec.requires_sections].sort().join(",");
    const codeSections = [...REQUIRED_SECTIONS[type]].sort().join(",");
    if (specSections !== codeSections) {
      drift.push(`${type}.requires_sections：taxonomy.yaml 是 [${specSections}]，代码是 [${codeSections}]`);
    }
    const specDays = spec.freshness?.confirm_within_days ?? null;
    if (specDays !== FRESHNESS_DAYS[type]) {
      drift.push(`${type} 的新鲜度窗口：taxonomy.yaml 是 ${String(specDays)}，代码是 ${String(FRESHNESS_DAYS[type])}`);
    }
  }

  // 新鲜度只许挂在会过期的东西上。`decision` 一旦 accepted 不可变、
  // `event` 是发生过的事、`rule` 靠 origin_incident 溯源——给它们定过期时间
  // 会让"确认一下"变成一种没有意义的动作，而没意义的动作会被跳过。
  for (const type of ["decision", "event", "rule"] as const) {
    if (taxonomy.asset_types[type]?.freshness != null) {
      drift.push(`${type} 不该有新鲜度：它不会过期，挂上它等于制造一个没有内容的检查项`);
    }
  }

  if (!Object.hasOwn(taxonomy.source_types, SOURCE_PREFIX)) {
    drift.push(`taxonomy.yaml 的 source_types 缺少 ${SOURCE_PREFIX}（来源层也要有 ID 前缀）`);
  }

  return drift;
}

/**
 * @param {Taxonomy} taxonomy
 * @param {AssetType} type
 * @returns {AssetTypeSpec | undefined}
 */
export function specOf(taxonomy: Taxonomy, type: AssetType): AssetTypeSpec | undefined {
  return taxonomy.asset_types[type];
}
