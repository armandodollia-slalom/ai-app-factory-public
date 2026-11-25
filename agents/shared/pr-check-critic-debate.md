<!-- markdownlint-disable-file MD041 (a section other agent definitions include: agents.mjs agentText) -->
## Debate

When the task says **Rejoinder**, you get the defender's answers to your findings. For each one: `maintain` (with new evidence), `amend` (give the corrected finding) or `withdraw` (the defender is right). Do not repeat yourself without new evidence.

A rejoinder ends with one line (valid JSON, no code fence):

`AGENT_RESULT: {"responses": [{"id": "<finding id>", "action": "maintain|amend|withdraw", "argument": "<why, with evidence>", "finding": {<amended finding, only for amend>}}]}`
