Extract only durable, high-signal working memory from the conversation text below.

Return JSON only. Use these rules:
- decisions: choices, tradeoffs, selected approaches
- workflows: repeatable steps or procedures
- conventions: stable defaults, rules, naming or path conventions
- notes: only useful residual items that do not fit the other categories
- Ignore routine file reads, tool chatter, and trivial back-and-forth
- Prefer concise standalone statements
- If a category has nothing useful, return an empty array

Conversation text:
{body}
