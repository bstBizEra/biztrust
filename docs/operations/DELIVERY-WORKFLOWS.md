# Delivery workflows

Six ordered stages carry work from a question to a running change. A stage may
send work back. No stage may be skipped because the next one looks ready.

Each stage names what it may produce and what it may not. The second list is
the one that matters, because the common failure is a stage granting itself the
next stage's authority.

## 1. Discovery

**Input:** a question, a problem or a request.
**Output:** a written statement of the problem, and what would answer it.

Produce the smallest statement that a reviewer can disagree with. Name the
affected modules from `modules/modules.yaml`. Name the decisions the work
depends on, and their real status in the guide register.

Discovery may not choose a solution, and it may not open a Work Package.

## 2. Research to decision

**Input:** a question that the repository cannot answer.
**Output:** a research note bound to sources, or a decision request.

Use official documentation. Cite a pinned revision. A research branch is never
merged, and it is cited by revision.

Research may not decide. When the answer is an architecture decision, it
becomes an ADR in the guide repository, and the ADR is decided by the
architecture authority. When the answer needs insurance, legal or finance
competence, it goes to the review seat that holds it.

Three of the five review seats are unfilled. Research that ends at one of them
stops there, and the stop is the result.

## 3. Implementation

**Input:** a Work Package with an objective, a bounded scope and acceptance
criteria.
**Output:** a change on a branch, with checks.

No ticket, no work. One package, one objective.

An epic is implemented only when `badf/gates.yaml` records `BT-G0` and
`badf/authority.yaml` records an implementation grant with an expiry from the
business authority seat.

Implementation may not widen its own scope, add a module, or mark its own work
accepted.

## 4. Review

**Input:** a candidate change.
**Output:** findings, each with evidence from that candidate.

Follow [the review method](REVIEW-METHOD.md). Build the environment. Do not
reason from the diff.

Plant the defect that each new check claims to catch, and watch the check fail
before keeping it. A check that has never failed has not been shown to work.
Three checks in the guide repository shipped green and hollow, and reading did
not find any of them.

The reviewer is a different role from the implementer. Review may not accept
the work on the implementer's assertion, and it may not record a gate.

## 5. Release

**Input:** a reviewed change with its findings resolved.
**Output:** a merge, and a recorded state transition.

Allowed transitions are in `badf/lifecycle.yaml`. A transition outside that
file is refused, not negotiated.

Release may not declare production and may not record a gate. A gate is
recorded by the named human role in `badf/gates.yaml`.

## 6. Production verification

**Input:** a released change.
**Output:** observed behavior in the target environment.

Only an observed action counts. A passing build is not an observation of
production, and a deploy step that succeeded is not proof the change works.

This stage is separately authorized. No stage above grants it.

## Routing

Route by the question, not by the role that noticed it.

| The work is | It goes to |
|---|---|
| A boundary, module or schema question | Architecture, and probably an ADR |
| An isolation, credential or access question | Security review |
| Cover state, money, jurisdiction or binding authority | A human review seat. Three are unfilled. |
| A behavior that a test can pin | Implementation, under a package |
| A claim about what is true today | Evidence, bound to a revision |

When two stages both seem to own the work, the earlier stage owns it. Moving
work forward to reach a stage with more authority is the failure this ordering
exists to prevent.
