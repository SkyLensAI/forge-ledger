# 资产库 · demo

> 本目录由 `forge demo` 从资产库生成，**不是手写样例**。

- 数据源：本仓库自己的资产（自举）
- 条数：44
- 说明：由 forge demo 从本仓库自己的 44 条资产生成。每一条都带可解析的出处；这里没有编造的样例数据。

## 重新生成

```bash
node apps/cli/src/main.ts demo --repo --out demo          # 写盘
node apps/cli/src/main.ts demo --repo --out demo --check  # 只比对，不写盘
```

页面没有外部依赖：直接打开 `index.html` 即可，不需要服务器、CDN 或网络。
