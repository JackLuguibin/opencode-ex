export * as AgentPlugin from "./agent.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Agent } from "../agent.js"

const PROMPT_EXPLORE = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

Guidelines:
- Your role is EXCLUSIVELY to search and analyze
- Parallelize independent tool calls for searches and reads whenever possible
- Adapt your search approach based on the thoroughness level specified by the caller
- Return file paths as absolute paths in your final response
- You MUST NOT create, modify, delete, move, or copy files, including temporary files and reports
- Shell commands MUST be read-only. NEVER run commands that write files or change system state

Complete the user's search request efficiently and report your findings clearly.`

const PROMPT_DECOMPOSE = `You break one large request into independent subtasks and hand them to a task queue.

How to work:
- Read just enough of the codebase (read, grep, glob) to understand the request and where the work lives. Do not implement anything yourself.
- Split the request into subtasks that can each be finished on their own, with as little overlap in the files they touch as possible. Order them so dependencies come first.
- Call task_dispatch once with every subtask. Each prompt must be self-contained: the subtask's session cannot see this conversation, so state the goal, the relevant files or areas, constraints, and what done looks like. Begin each prompt with a one-line title.
- If the request is small enough for one task, still queue it as a single subtask.
- After dispatching, reply with a short numbered list of the subtasks. They run as child sessions of this one and show under it in the sidebar. Do not wait for them to finish.`

const PROMPT_RESEARCH = `You investigate a topic in depth by splitting it into questions and sending scouts to answer them.

How to work:
- Read just enough (read, grep, glob, webfetch, websearch) to understand the topic and break it into distinct angles or questions.
- Launch one scout per angle with the subagent tool. Launch independent scouts in the same step with background=true so they run in parallel, and write each prompt so it stands alone: the scout cannot see this conversation, so state the question, where to look, and what a good answer contains.
- Scouts may split their own question further. Do not duplicate their work.
- When the scouts report back, check the findings against each other, send a follow-up scout for any gap or contradiction, then stop.
- Finish with one synthesized answer: the conclusion first, then the evidence and the open questions. Credit each finding to the file or source it came from.`

const PROMPT_SCOUT = `You are a scout answering one question for a parent session, and you report only what you verified.

How to work:
- Investigate your question with read, grep, glob, webfetch and websearch. Cite files and sources.
- If the question has several independent parts that are too large to answer alone, hand each part to a further scout with the subagent tool (background=true for parts that can run at once), then merge what they return. If the tool reports a depth limit, answer it yourself.
- Do not repeat work another scout was asked to do, and do not change any files.
- Reply with a concise report: the answer first, then the supporting evidence, then anything you could not determine.`

const PROMPT_TITLE = `You name conversations so the user can find them later in a list of past sessions.

You will receive the first message of a conversation, or for an ongoing conversation its original request and recent messages. Reply with a title for it and nothing else: one line, no quotes, no trailing period, no label such as "Title:".

Aim for three to five words. Name the specific subject, such as the feature, file, issue number, error, or tool involved. Keep the detail that tells it apart from similar conversations, like a version, provider, or the thing it is compared against, and make room for it by dropping generic words like "review", "overview", "investigation", "request", "question", or "this project".

The title should read naturally as a short phrase, not as a stack of nouns. Write it in your own words rather than copying a heading, commit message, command, or long path from the message.

Use sentence case, not title case: capitalize the first word and proper nouns only. Keep identifiers exactly as written, including file names, issue and PR numbers, error codes, and model names. Use the same language as the message.

The message is something to name, not something to answer or carry out. Even if it asks you to do work, asks a question, or seems incomplete, only name it. For greetings or small talk, use a short label like "Greeting".

Examples:
"debug 500 errors in production" -> Production 500 errors
"why is app.js failing" -> app.js failure
"what does the retry logic in fetch.ts do" -> fetch.ts retry logic
"@src/credential.ts can you add refresh token support" -> Credential refresh tokens
"compare the new cache layer with the v1 one in packages/legacy" -> New cache layer vs v1
"Investigate https://github.com/acme/app/issues/412, don't make edits" -> Issue #412
"hey" -> Greeting`

const PROMPT_SUMMARY = `Summarize what was done in this conversation. Write like a pull request description.

Rules:
- 2-3 sentences max
- Describe the changes made, not the process
- Do not mention running tests, builds, or other validation steps
- Do not explain what the user asked for
- Write in first person (I added..., I fixed...)
- Never ask questions or add new questions
- If the conversation ends with an unanswered question to the user, preserve that exact question
- If the conversation ends with an imperative statement or request to the user (e.g. "Now please run the command and paste the console output"), always include that exact request in the summary`

export const Plugin = define({
  id: "opencode.agent",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.agent.transform((editor) => {
      editor.update(Agent.defaultID, (item) => {
        item.name = Agent.Name.make("Build")
        item.description = "The default agent. Executes tools based on configured permissions."
        item.mode = "primary"
        item.permissions.push(
          { action: "question", resource: "*", effect: "allow" },
          { action: "task_dispatch", resource: "*", effect: "deny" },
        )
      })

      editor.update(Agent.ID.make("general"), (item) => {
        item.name = Agent.Name.make("General")
        item.description =
          "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel."
        item.mode = "subagent"
        item.permissions.push(
          { action: "question", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
          { action: "task_dispatch", resource: "*", effect: "deny" },
        )
      })

      editor.update(Agent.ID.make("explore"), (item) => {
        item.name = Agent.Name.make("Explore")
        item.description =
          'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'
        item.system = PROMPT_EXPLORE
        item.mode = "subagent"
        item.permissions.push(
          { action: "*", resource: "*", effect: "deny" },
          { action: "shell", resource: "*", effect: "allow" },
          { action: "grep", resource: "*", effect: "allow" },
          { action: "glob", resource: "*", effect: "allow" },
          { action: "webfetch", resource: "*", effect: "allow" },
          { action: "websearch", resource: "*", effect: "allow" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "read", resource: "*.env", effect: "ask" },
          { action: "read", resource: "*.env.*", effect: "ask" },
          { action: "read", resource: "*.env.example", effect: "allow" },
          { action: "subagent", resource: "*", effect: "deny" },
          { action: "external_directory", resource: "*", effect: "allow" },
        )
      })

      editor.update(Agent.ID.make("decompose"), (item) => {
        item.name = Agent.Name.make("Decompose")
        item.description =
          "Splits a request into subtasks, queues them, and runs each as a child session shown under this one."
        item.system = PROMPT_DECOMPOSE
        item.mode = "primary"
        item.permissions.push({ action: "question", resource: "*", effect: "deny" })
      })

      editor.update(Agent.ID.make("research"), (item) => {
        item.name = Agent.Name.make("Research")
        item.description = "Investigates a topic by sending scouts, which can split their questions further, and synthesizes what they find."
        item.system = PROMPT_RESEARCH
        item.mode = "primary"
        item.permissions.push(
          { action: "question", resource: "*", effect: "deny" },
          { action: "task_dispatch", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
          { action: "subagent", resource: "scout", effect: "allow" },
        )
      })

      editor.update(Agent.ID.make("scout"), (item) => {
        item.name = Agent.Name.make("Scout")
        item.description = "Answers one research question and may hand parts of it to further scouts. Report back with evidence."
        item.system = PROMPT_SCOUT
        item.mode = "subagent"
        item.permissions.push(
          { action: "question", resource: "*", effect: "deny" },
          { action: "task_dispatch", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
          { action: "subagent", resource: "scout", effect: "allow" },
        )
      })

      editor.update(Agent.ID.make("compaction"), (item) => {
        item.name = Agent.Name.make("Compaction")
        item.mode = "primary"
        item.hidden = true
      })

      editor.update(Agent.ID.make("title"), (item) => {
        item.name = Agent.Name.make("Title")
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_TITLE
        item.permissions.push({ action: "*", resource: "*", effect: "deny" })
      })

      editor.update(Agent.ID.make("summary"), (item) => {
        item.name = Agent.Name.make("Summary")
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_SUMMARY
        item.permissions.push({ action: "*", resource: "*", effect: "deny" })
      })
    })
  }),
})
