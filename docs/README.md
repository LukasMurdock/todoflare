# Documentation

Start with [architecture.md](architecture.md). Everything here describes the
system as it is now, except `history/`.

| Document | Answers |
| --- | --- |
| [architecture.md](architecture.md) | What are the pieces, where do they live, how do the main requests flow, what must stay true? |
| [domain.md](domain.md) | What do Account ID, grant, projection, freeze, … mean here? |
| [development.md](development.md) | How do I run, test, debug and make common changes? |
| [decisions/](decisions/) | Why is it built this way? |
| [operations.md](operations.md) | How is production released, frozen, backed up and restored? |
| [staging.md](staging.md) | The staging environment, the release gate step by step, and the release log |
| [proposals/](proposals/) | Longer designs for agent access, passkeys, the embeddable board and change locality, with their results |
| [history/](history/) | Finished reports and superseded plans, kept as evidence |
| [../packages/board/README.md](../packages/board/README.md) | Embedding `@todoflare/board` in another app |
| [../agent-patterns/xstate.md](../agent-patterns/xstate.md) | XState conventions |
