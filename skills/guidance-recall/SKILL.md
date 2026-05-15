---
name: guidance-recall
description: "Read guidance compiled by context-manager for the current repository. Use when the user's question depends on prior repo-specific decisions, workflows, conventions, or previously compiled high-level guidance. Start from `guidance/index.md`, then drill into one relevant category index and 1-2 relevant guidance pages. Only follow linked `working-memory/*.md#anchor` sections when the guidance page is insufficient. Skip when the answer depends only on current code state or the user explicitly asked to ignore historical guidance."
---

You are retrieving project guidance from context-manager outputs.

## Goal

Read the smallest amount of compiled guidance needed for the current question.

## Steps

1. Check whether `guidance/index.md` exists in the current repository. If it does not exist, stop and say no compiled guidance is available yet.
2. Read `guidance/index.md` and choose the single most relevant category.
3. Read that category index, typically one of:
   - `guidance/decisions/index.md`
   - `guidance/workflows/index.md`
   - `guidance/conventions/index.md`
4. Read only 1-2 relevant guidance pages from that category.
5. If those pages link to `working-memory/*.md#anchor` and the high-level guidance is still insufficient, read only the linked anchor section.
6. Return a concise summary of the relevant guidance and cite the files you used.

## Rules

- Prefer `guidance/` over raw `working-memory/`.
- Do not bulk-read every guidance page or every working-memory file.
- Treat category indexes as navigation, not as the final answer.
- If a category index or top index only says `No guidance pages here yet.`, say compiled guidance is not ready rather than inventing detail.
- If the question is purely about current code behavior, inspect the code instead of using this skill.

## Output

Organize the result by the guidance that matters right now.

- State the key decision, workflow, or convention.
- Include source references for traceability.
- If nothing relevant exists, say `No relevant compiled guidance found.`
