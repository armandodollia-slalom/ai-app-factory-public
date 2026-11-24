# Pipeline explorer redesign: preliminary mockup

**Status:** preliminary. This is a design sketch, not the product. The shipped explorer is [pipeline-explorer.html](../../pipeline-explorer.html).

- [mockup.html](mockup.html): a clickable mockup. Click a phase to zoom in.
- [default-view.png](default-view.png): the view the page opens on.
- [zoomed-view.png](zoomed-view.png): one phase zoomed in, with a step's settings.

The mockup predates GEN-8: its per-stage council switches (`council.pairVerify`, `council.testPlan`, `council.testAutomation`, `council.prCheck`, on or off) are gone. A stage now seats as many members as its `councilMembers` says (one by default), with its own `maxCouncilRounds` and `councilPassScore`; GEN-5 replaces this mockup.

What is a placeholder in the mockup: the grouping of steps into phases, the number of stops per phase, the wording of what a person does at each stop, and the settings of every phase except Verify.
