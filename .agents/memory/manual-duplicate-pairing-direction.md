---
name: Manual duplicate pairing direction
description: Which document becomes primary vs duplicate when a user manually pairs two cost documents from a candidate list
---

When a document detail page lists heuristic "possible duplicate" candidates and
the user clicks a per-candidate "pair as duplicate" action, the CURRENT
document (the one being viewed) must stay primary and the CANDIDATE must
become the linked duplicate — i.e. call the mark-duplicate mutation with
`id: candidateId, primaryDocumentId: currentDocId`, not the reverse.

**Why:** the natural mistake is to pass the mutation's own record id as `id`
and the clicked candidate's id as `primaryDocumentId`, which flips the
relationship (the page you're looking at becomes the hidden duplicate,
and the candidate silently becomes primary). This only surfaces when you
check the *other* document's page for the "this is a duplicate of #X"
banner — a plain click-and-toast check on the origin page doesn't catch it.

**How to apply:** for any "pair with a candidate found from my current
record" UI, write the mutation args as
`{ id: candidateId, data: { primaryDocumentId: currentId } }` and verify by
loading the candidate's own detail/edit page afterward, not just the
originating page.
