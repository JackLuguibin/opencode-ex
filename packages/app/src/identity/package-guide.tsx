import { For, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import "./global-packages.css"

export type GuideKind = "skill" | "plugin" | "mcp"

const SECTIONS = {
  skill: { structure: 3, rules: 5, limits: 4 },
  plugin: { structure: 3, rules: 5, limits: 4 },
  mcp: { structure: 2, rules: 5, limits: 3 },
} as const

const EXAMPLES: Record<GuideKind, string> = {
  skill: `lead-search.zip
└── lead-search/            # 可选：外面再包一层文件夹
    ├── SKILL.md            # 必需，在最上层
    └── scripts/search.py   # 可选：脚本、资料

---
name: lead-search
description: 当用户要查找销售线索时使用，说明何时加载
---
# 正文：给助手的步骤和注意事项`,
  plugin: `crm-plugin.zip
├── package.json            # 必需，在最上层
└── server.js               # 入口

// package.json
{ "name": "crm-plugin", "version": "1.0.0", "type": "module", "main": "server.js" }

// server.js
export default {
  id: "crm-plugin",
  setup: async (ctx) => {
    // 在这里注册钩子，例如 ctx.skill.transform(...)
  },
}`,
  mcp: `远程：
  服务器地址   https://mcp.example.com/sse
  请求头       Authorization: Bearer <令牌>

本地：
  启动命令     /usr/bin/python3 /srv/tools/server.py
  环境变量     API_KEY=<值>`,
}

/** What an author needs to know before uploading: layout, rules and the limits the server enforces. */
export function PackageGuide(props: { kind: GuideKind }) {
  const language = useLanguage()
  const dialog = useDialog()
  const open = () =>
    void dialog.show(() => (
      <Dialog fit size="large">
        <DialogHeader>
          <DialogTitleGroup title={language.t(`account.guide.${props.kind}.title`)} />
        </DialogHeader>
        <DialogBody>
          <div data-component="package-guide">
            <p>{language.t(`account.guide.${props.kind}.summary`)}</p>
            <For each={Object.entries(SECTIONS[props.kind])}>
              {([section, count]) => (
                <section>
                  <h4>{language.t(`account.guide.section.${section}`)}</h4>
                  <ul>
                    <For each={Array.from({ length: count }, (_, index) => index + 1)}>
                      {(index) => <li>{language.t(`account.guide.${props.kind}.${section}.${index}`)}</li>}
                    </For>
                  </ul>
                </section>
              )}
            </For>
            <section>
              <h4>{language.t("account.guide.section.example")}</h4>
              <pre>{EXAMPLES[props.kind]}</pre>
            </section>
            <Show when={props.kind !== "mcp"}>
              <p class="package-guide-note">{language.t("account.guide.common")}</p>
            </Show>
            <div class="package-actions">
              <Button type="button" variant="contrast" onClick={() => dialog.close()}>
                {language.t("account.guide.close")}
              </Button>
            </div>
          </div>
        </DialogBody>
      </Dialog>
    ))
  return (
    <Button variant="ghost" icon="help" class="shrink-0" onClick={open}>
      {language.t("account.guide.open")}
    </Button>
  )
}
