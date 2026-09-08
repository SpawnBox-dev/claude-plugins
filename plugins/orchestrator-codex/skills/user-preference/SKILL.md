---
name: user-preference
description: Record or retrieve an explicit user preference relevant across tasks.
---

Read `user_profile({action:"view"})`. For a user-stated preference use `user_profile({action:"set",dimension:"preference",observation:"..."})`. Preserve the scope of what the user said; a single task exception is not a universal rule. Use supported dimensions only. Avoid duplicating an existing observation.
