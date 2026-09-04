# Vision — job-applier-agent

*Draft. Not ratified. Per global standing orders §1, vision documents are
drafted in-session and committed only after Mahi reviews them.*

## The problem, in the operator's own numbers

| Channel | Volume | Callbacks | Rate |
|---|---|---|---|
| Form applications | 50+ | 1–2 | **~3%** |
| Cold message → connection accepted | 10 | 4–5 | **~50%** |

Roughly a 15–20× difference. The form is not the application; the outreach is.
The form is a compliance step so nobody can say the process was skipped.

That single fact determines the whole design. The scarce resource is not job
listings — those are free and abundant. It is **a specific true thing to say to
a named human who can actually decide**, produced often enough to matter.

Producing that by hand takes about twenty minutes per role: find who owns the
work, read what they have written, find the one observation worth opening with.
At that cost a person sustains maybe five a week, and does it badly when tired.

## What this system is

A machine that produces **outreach-ready candidates**: a role worth pursuing, a
named person who decides, and one grounded observation to open with. It stops
one step before contact.

It does not send. Not as a limitation — as the design. Automated connection
requests violate LinkedIn's terms, are detected by request velocity, and would
cost the account that carries the operator's entire professional history and
the only channel that converts. Automating the click saves fifteen seconds and
moves the 50% not at all, because acceptance is decided by *who was chosen* and
*what the note says*, both of which happen before it.

## The bet worth testing

Everything expensive here is judgment: which of ten search results owns the
work, whether this post is a real observation or noise, which of three
companies sharing a name is the right one.

If a 3-billion-parameter model on a machine that costs nothing can do that
judgment, the marginal cost of an outreach candidate approaches zero, and the
system becomes viable at a volume that changes outcomes rather than one that
merely demonstrates the idea. If it cannot, the work still gets done — it just
costs cents per candidate instead of nothing, and the question becomes how many
candidates are worth cents.

Either answer is useful. The unacceptable outcome is not knowing, which is
where every unmeasured agent system ends up.

## What must never be traded away

**Nothing reaches a human unverified.** An observation is only real if the text
it rests on appears in something a tool actually returned. This is checked, not
requested. A fabricated observation is worse than none — it goes to a real
person who will know it is false, and it costs the relationship the whole
system exists to create.

**Rejections stay explainable.** Three thousand postings are discarded per pass.
Every one records which gate rejected it and why, because "the agent decided"
is not an answer when the thing it decided was to skip the role you wanted.

**Cost is visible before it is spent, not after.** Every paid path declares its
price and is refused at a ceiling.

## How it should feel to use

A short list each morning: here are eight people, here is why each, here is
what to say. Five minutes of clicking. The operator's judgment is spent on
whether to send, never on assembling what to send.

## What this is not

Not a job board, not an application autofiller, not a CRM, and not a system
that talks to anyone on the operator's behalf. Those are all things that would
make it worse.
