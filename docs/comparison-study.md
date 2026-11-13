# Comparison study protocol

**Status: proposed protocol, 14 November 2026, awaiting the owner.** Nothing here has been run, and nobody has been invited. Every conversation, name, place, note and cue below is fictional. This protocol is how roadmap items V5, V6 and V7 could be tested; it does not tick them. The owner's open decisions are listed at the end, and they must be settled and recorded here, with the date, before the first counted session.

It builds on the design described in [PRODUCT.md](../PRODUCT.md#goal-and-first-proof), [the next experiment in the research notes](research.md#the-next-experiment), the user-value rows of the [pilot acceptance criteria](pilot-acceptance.md#user-value) (including their stop rule and data rows), and the [Glance view comparison](glance-mode.md#what-should-be-tested-next). The phrase-rule measurements in [cue intelligence](cue-intelligence.md) are a separate question: this study uses human-selected cues so that detection errors do not decide the result.

## What it answers, and what it does not

| Roadmap item                                                                                                                    | What this protocol provides                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **V5** No assistance against stable, human-selected questions, matched conversations, counterbalanced order                     | The question pair (Q-A, Q-B), each heard with and without questions                                                                                                                                            |
| **V6** Source-backed context reminders as a separate human-cued condition                                                       | The reminder pair (R-A, R-B), each heard with and without reminders drawn from notes the participant read beforehand                                                                                           |
| **V7** Useful participation and listening comprehension measured together; unsupported, already-answered and late cues included | Every assisted conversation includes one already-answered (or redundant) cue, one late cue and one unsupported cue beside three useful ones; participation and comprehension are scored for every conversation |
| **V8** Whether the **Why?** hold is discoverable                                                                                | Not answered. Cues are shown without the app's controls in the first delivery option below                                                                                                                     |
| **V9** Keyboard route, VoiceOver, reading time                                                                                  | Not answered                                                                                                                                                                                                   |
| **V10** Content, timing and placement tested separately                                                                         | Content only. Timing (immediately after the trigger line, 18 seconds on screen) and placement (bottom right) are held fixed                                                                                    |
| **V11** Outcome labels                                                                                                          | Not answered                                                                                                                                                                                                   |

It cannot show that automatically detected cues would help, that any benefit holds in real meetings, or any benefit for a particular group of people. It is a small formative comparison.

## Design at a glance

- **Within-participant.** Each participant hears four scored conversations: both of the question pair and both of the reminder pair. In each pair, one conversation has cues and the other has none.
- **Matched pairs.** The two conversations in a pair have the same 28-line structure, the same speaker turns, cue positions, pauses and open items in the same places, and line lengths within three words of each other. Only the subject matter differs.
- **Counterbalanced.** Eight sequences balance which part comes first, which conversation in a pair is heard first, and which one has cues (see [Counterbalancing](#counterbalancing-schedule)).
- **Live readers.** Two readers perform each conversation over a video call, so the participant can speak and be answered. Readers use fixed answer cards, so a participant's question changes what they hear only in prepared ways.
- **Authored cues.** The facilitator shows each cue when its trigger line ends, from a fixed schedule. The unassisted conversation shows the same empty cue window throughout.
- **About an hour** per session, including consent, a practice conversation and short questions after each conversation.

## People and roles

- **Participants:** adults (18 or over) who take part in meetings in English, at work or in a volunteer group. They should not have worked on TalkQTE or seen these scripts. Avoid people who might feel obliged to take part, such as anyone the owner manages. Do not screen or select on age beyond 18, health, disability, neurotype or job.
- **Facilitator** (the owner, or someone the owner briefs): runs consent, the practice, cue timing, the coding sheet and the questions. Sits beside the participant, out of their direct line of sight.
- **Two readers:** read the conversations at a steady, natural pace (about 150 words a minute), keep the marked pauses, and reply to the participant only from the answer cards. Readers' copies show the pauses and answer cards but **not** the cue marks, and readers cannot see the participant's cue window, so their reading does not change with the condition.

Pre-generated synthetic audio (as in V1) would remove the readers, but recorded audio cannot reply when the participant speaks, which this study needs. Live readers are therefore the default.

## Setup and cue delivery

**Option A (no new build; the default).**

- **Call.** The participant joins a video call on a laptop; the two readers are on the call with cameras on. Turn off the call's recording, transcription and AI features before the session. If the participant asks for captions, switch them on for all four conversations and note "captions on" as a setup detail, nothing more.
- **Cue window.** A slide deck runs in a small window at the bottom right of the participant's screen, above the call, matching the app's default companion position. Each cue is one slide in the companion's style: one complete question, or for a reminder the note text with its label "From your notes, (date). Not from this conversation." A blank slide sits between cues.
- **Timing.** The facilitator clicks a presenter remote once, as soon as the trigger line ends, to show the cue. The slide returns to blank by itself after 18 seconds, the app's unread cue lifetime. If a trigger line ends while the previous cue is still showing, the facilitator clicks once to clear it and once more to show the next. Only one cue is ever visible.
- **Equipment.** The facilitator supplies the laptop, so nothing is installed on the participant's own device. The participant joins the call under their participant code, not their name, and may keep their camera off.
- **Matching.** The unassisted conversation uses a deck of blank slides only.
- **Controls.** Participants cannot dismiss or hold a cue in this option. Tell them they may ignore any prompt.

**Option B (later).** Once an app build can replay an authored cue schedule with the companion's real controls (V2 and V3), the same schedules can be loaded there. Dismiss and **Why?** then become observable, which would add V8. Do not mix the two options within one rotation of eight sessions.

At 150 words a minute with no pause between turns, the closest cues in any assisted schedule are 20 seconds apart, so the 18-second display does not overlap the next cue. At 165 words a minute the closest pair is about 18 seconds apart, so readers should stay at or below about 160. A participant's own turns only lengthen the gaps. Any video call passes audio through the call provider's service; choose one whose recording, transcription and AI features can be switched off.

## The participant's brief (read aloud)

> You're joining a small volunteer group as a new member. Two people will talk through their plans, in four short meetings of about three minutes each. You can speak at any time, ask anything, offer to help, or stay quiet; all of those are fine. Sometimes a short prompt may appear in the small window in the corner. The prompts were written in advance and may be helpful, late, unnecessary or wrong, so use them or ignore them as you like. In some meetings no prompts appear. Please don't take notes. After each meeting there are a few questions about what was said. We are testing the prompts, not you.

## Practice conversation (not scored)

Shown first in every session so each participant has seen one question and one reminder before the first scored conversation. Notes card for the practice: _"Your notes, 1 May: the water butt is empty until it rains."_ Show it for 30 seconds, then take it away.

1. **Kit:** The garden open day is in May, and we'd like a plant stall by the gate.
2. **Lou:** Someone should ask the allotment society for spare seedlings. **[cue: "Who will ask the allotment society?"]**
3. **Kit:** Last year they gave us two trays of tomatoes and a box of herbs.
4. **Lou:** People liked the herbs most, especially the mint and the basil.
5. **Kit:** We could water everything from the water butt on the morning. **[reminder, once the question has cleared, labeled "From your notes, 1 May. Not from this conversation.": "The water butt is empty until it rains."]**
6. **Lou:** Good, that's the plan for now, then.

Answer anything the participant asks with "Good question, let's say I'll find out." Do not score the practice.

## Question pair

Both conversations follow the same structure. The participant plays a new volunteer.

### Open items and windows

An **open item** is something the conversation leaves unresolved, which a useful clarification would settle. A **window** runs from the end of the item's line to the start of the line named as its close. Raising the item inside the window is **in time**; raising it after the window but before the conversation ends is **later**.

| Item                 | Q-A                               | Q-B                                | Opens after line | Closes when line … begins | Cue in the assisted version                                   |
| -------------------- | --------------------------------- | ---------------------------------- | ---------------- | ------------------------- | ------------------------------------------------------------- |
| U1, missing owner    | who collects the tables on Friday | who collects the cones on Saturday | 3                | 7                         | Useful, shown after line 3                                    |
| U2, vague deadline   | when the volunteer rota is due    | when the marshal list is due       | 13               | 15                        | Useful, shown after line 13                                   |
| L, open choice       | chalkboard or printed signs       | medals or certificates             | 15               | 17                        | Late, shown after line 18, after the topic changed at line 16 |
| U3, unexplained term | what the HEF is                   | what the TMP is                    | 22               | 26                        | Useful, shown after line 22                                   |

The question pair also has the following moments, which are not open items:

- **Line 5 (stay quiet):** "Someone also has to bring …", resolved by the same speaker in the same turn. Neither condition shows a cue here.
- **Line 8 (already answered):** a vague deadline that line 9 answers at once. The assisted version shows a cue asking for it after line 9, once the conversation has already answered it, as a system that failed to notice the answer would.
- **Line 25 (unsupported):** the assisted version shows a cue about something never mentioned.

### Q-A: Spring book sale

Speakers: Wren and Dev, of a library friends group.

1. **Wren:** Thanks for coming. The spring book sale is on Saturday the twenty-second, in the library's back room, same as last year.
2. **Dev:** We've had a good year for donations. There are thirty-one boxes in the storeroom already, mostly paperbacks.
3. **Wren:** We'll need the folding tables from the community centre, and someone has to collect them on Friday afternoon. **[U1]**
4. **Dev:** Their office closes at four on Fridays, so it can't be a late pickup. _(pause 3 s)_
5. **Wren:** Someone also has to bring the cash float. I'll do that, I've got the tin at home.
6. **Dev:** Prices stay the same as last time: paperbacks a pound, hardbacks two pounds, and children's books fifty pence.
7. **Wren:** Good. Now, posters.
8. **Dev:** The posters need to go up soon, or people won't hear about it in time.
9. **Wren:** By Saturday the eighth, so they're up for two weeks before the sale. **[AA]**
10. **Dev:** I'll put them on the library noticeboard, in the bakery window and at the station.
11. **Wren:** The library will lend us the big easel for the front door as well.
12. **Dev:** Last year we had twelve volunteers, but three of them have moved away since.
13. **Wren:** We'll also need the volunteer rota sorted at some point. **[U2]** _(pause 3 s)_
14. **Dev:** Shifts were two hours long last time, and that worked well for most people.
15. **Wren:** For the signs, we could do either chalkboards or printed ones.
16. **Dev:** They both have their good points. Anyway, the café corner.
17. **Wren:** The bakery is giving us two trays of scones, and the church is lending us their tea urn.
18. **Dev:** We'll sell tea at fifty pence a cup, and squash for the children at twenty. **[L]**
19. **Wren:** The church wants the urn back by six on the Saturday evening.
20. **Dev:** Their hall is busy on Sunday morning, so it really does need to go back that night.
21. **Wren:** We'll do the washing up in the staff kitchen at the end of the day.
22. **Dev:** One more thing: we'll need to send the HEF to the council before we can sell any food. **[U3]**
23. **Wren:** I can drop it in to the council office on my way to work. _(pause 3 s)_
24. **Dev:** Great. I think that's most of the sale covered now, which is a real relief.
25. **Wren:** The till roll, the price stickers and the spare bags are all in the cupboard by the door. **[X]**
26. **Dev:** Doors open at ten, and we can start setting up from eight.
27. **Wren:** Is there anything else before we finish? _(pause 5 s)_
28. **Dev:** Then the next meeting is Thursday the sixth, at seven, here.

### Q-B: School fun run

Speakers: Ola and Pim, of a parents' association.

1. **Ola:** Thanks for coming. The school fun run is on Sunday the fourteenth, on the playing field, same as last year.
2. **Pim:** We've had a good year for sign-ups. There are forty-six children registered already, mostly younger ones.
3. **Ola:** We'll need the traffic cones from the sports club, and someone has to collect them on Saturday morning. **[U1]**
4. **Pim:** Their shed is only open until eleven on Saturdays, so it can't be a late pickup. _(pause 3 s)_
5. **Ola:** Someone also has to bring the first-aid kit. I'll do that, I keep it in my car.
6. **Pim:** Entry stays the same as last time: three pounds a child, five pounds for families, and adults run free.
7. **Ola:** Good. Now, leaflets.
8. **Pim:** The leaflets need to go out soon, or families will make other plans.
9. **Ola:** By Monday the first, so families get two weeks' notice before the run. **[AA]**
10. **Pim:** I'll hand them out at the school gate, in the newsletter and at the swimming pool.
11. **Ola:** The school will lend us the big whistle for the start line as well.
12. **Pim:** Last year we had ten marshals, but four of them can't make it this time.
13. **Ola:** We'll also need the marshal list sorted at some point. **[U2]** _(pause 3 s)_
14. **Pim:** Each marshal stood at one corner last time, and that worked well for most people.
15. **Ola:** For the finish, we could do either medals or certificates.
16. **Pim:** They both have their good points. Anyway, the water station.
17. **Ola:** The supermarket is giving us six packs of bottled water, and the scouts are lending us a gazebo.
18. **Pim:** We'll sell fruit at fifty pence a piece, and flapjacks for the parents at a pound. **[L]**
19. **Ola:** The scouts want the gazebo back by five on the Sunday afternoon.
20. **Pim:** They're camping the next weekend, so it really does need to go back that day.
21. **Ola:** We'll collect the litter in the bin bags from the caretaker at the end.
22. **Pim:** One more thing: we'll need to send the TMP to the council before we can close the lane. **[U3]**
23. **Ola:** I can drop it in to the council office on my way to work. _(pause 3 s)_
24. **Pim:** Great. I think that's most of the run covered now, which is a real relief.
25. **Ola:** The bibs, the safety pins and the spare markers are all in the box by the staff room door. **[X]**
26. **Pim:** Registration opens at nine, and we can start setting up from seven.
27. **Ola:** Is there anything else before we finish? _(pause 5 s)_
28. **Pim:** Then the next meeting is Wednesday the third, at seven, here.

### Question cue schedules

| Cue | After line | Kind                                                                                                                    | Q-A cue text                                               | Q-B cue text                                         |
| --- | ---------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| U1  | 3          | Useful                                                                                                                  | Who will collect the tables on Friday?                     | Who will collect the cones on Saturday?              |
| AA  | 9          | Already answered: line 9 has just given the date                                                                        | When do the posters need to go up?                         | When do the leaflets need to go out?                 |
| U2  | 13         | Useful                                                                                                                  | When does the volunteer rota need to be done?              | When does the marshal list need to be done?          |
| L   | 18         | Late: the choice was raised at line 15 and the topic changed at line 16, about 17 seconds earlier at 150 words a minute | How will you choose between chalkboards and printed signs? | How will you choose between medals and certificates? |
| U3  | 22         | Useful                                                                                                                  | What is the HEF?                                           | What is the TMP?                                     |
| X   | 25         | Unsupported: nothing in the conversation mentions it                                                                    | Who is picking up the banner from the printer?             | Who is picking up the trophies from the engraver?    |

The unassisted schedule is the same deck with every slide blank.

### Question answer cards

When the participant speaks, the reader in the middle of a line finishes it (or repeats it if it was drowned out). The reader named on the matching card then gives its reply, and the conversation continues with the next line. The same rule applies to the reminder answer cards below.

| When the participant …                            | Q-A reply                                                                            | Q-B reply                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| asks who will do U1                               | Dev: "Good point. I can do it, I'll bring my car."                                   | Pim: "Good point. I can do it, I'll bring my car."                               |
| offers to do U1 themselves                        | Wren: "Great, thank you. That's the tables sorted."                                  | Ola: "Great, thank you. That's the cones sorted."                                |
| asks when U2 is due                               | Wren: "Let's say by the fifteenth, so people get a week's notice."                   | Ola: "Let's say by the seventh, so people get a week's notice."                  |
| asks or suggests how to settle L                  | Wren: "Printed, I think; they'll last for next year too."                            | Ola: "Medals, I think; the children love them."                                  |
| asks what U3 means                                | Dev: "Sorry, the hall event form. The council asks for it when an event sells food." | Pim: "Sorry, a traffic management plan. The council needs it to close the lane." |
| asks about the unsupported cue's subject          | Wren: "I don't think we've got a banner this year."                                  | Ola: "I don't think there are trophies this year."                               |
| asks the line 8 question before line 9            | Wren says line 9 as the reply                                                        | Ola says line 9 as the reply                                                     |
| asks the line 8 question after line 9 answered it | Wren: "The eighth, like I said."                                                     | Ola: "The first, like I said."                                                   |
| asks anything else                                | "Good question, let's check that after."                                             | same                                                                             |
| comments without asking                           | "Mm, yes."                                                                           | same                                                                             |

## Reminder pair

The participant plays someone who was at the group's last meeting and took notes. Before each reminder conversation, the facilitator shows that conversation's notes card for two minutes and then takes it away, **in both conditions**. A reminder therefore brings back something the participant has already read; it does not add new information.

### Open items and windows

| Item                           | R-A                                                               | R-B                                                                | Opens after line | Closes when line … begins | Cue in the assisted version                                   |
| ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------- | ------------------------- | ------------------------------------------------------------- |
| U1, plan conflicts with a note | Saturday move, but the lift is closed at weekends                 | Friday-evening rehearsal, but the hall is not free then            | 3                | 7                         | Useful, shown after line 3                                    |
| U2, plan conflicts with a note | six desks ordered, but Joel's team needs eight                    | twelve chairs, but Tomas's section has fourteen                    | 13               | 15                        | Useful, shown after line 13                                   |
| L, plan conflicts with a note  | relying on the dishwasher, which arrives in April                 | tuner booked days before, but needs two weeks' notice              | 15               | 17                        | Late, shown after line 18, after the topic changed at line 16 |
| U3, plan conflicts with a note | carrying things over on the 27th, before the handover on the 28th | rigging lights on Thursday, but the caretaker is away until Friday | 22               | 26                        | Useful, shown after line 22                                   |

The reminder pair also has the following moments, which are not open items:

- **Line 5 (stay quiet):** a speaker states a note's content themselves, so neither condition shows a reminder.
- **Line 9 (redundant, RD):** line 9 states a note's content, and the assisted version then shows that same note as a reminder.
- **Line 25 (unsupported):** the assisted version shows a reminder that misstates a figure on the card. A reminder quoting a note word for word could not make this error, but cue text written by a model could. A reminder that is accurate but irrelevant is a different failure, and this study does not test it.

### R-A: Office move

Speakers: Hana and Joel, of a small charity office.

Notes card (show for two minutes): **Your notes from the last meeting, 3 March**

- The building's lift is out of service at weekends, so movers can't use it on a Saturday or Sunday.
- The new kitchen has no dishwasher until April.
- Joel's team needs eight desks, not six.
- The old printer goes back to the leasing company; it isn't moving.
- Parking permits at the new building take ten working days.
- Leaving-do budget: £60.
- The new office is handed over on the 28th; nobody can go in before then.

1. **Hana:** Thanks for coming. The office move to Mill Street is at the end of the month, and we're nearly ready.
2. **Joel:** Packing has gone well. There are fifty-two crates packed already, mostly files from the back room.
3. **Hana:** I've booked the removal firm for Saturday the twenty-ninth, so that nobody has to lose a working day. **[U1]**
4. **Joel:** The firm said they need about five hours to move everything. _(pause 3 s)_
5. **Hana:** And the printer's going back to the leasing company anyway, so that's one less thing to move.
6. **Joel:** The phones switch over on the Monday morning, and the internet on the Friday before.
7. **Hana:** Good. Now, parking.
8. **Joel:** People will want to drive to the new building, so we'll need parking permits.
9. **Hana:** They take ten working days, so I applied for them this morning. **[RD]**
10. **Joel:** There are twelve parking spaces, and the bike shed holds another twenty bikes.
11. **Hana:** The new building has a shower as well, for anyone who cycles in from the far side of town.
12. **Joel:** The old desks are too worn to move, so they're going to a charity shop.
13. **Hana:** For furniture, we'll order six new desks for Joel's team. **[U2]** _(pause 3 s)_
14. **Joel:** The chairs are fine, so we're keeping all of them.
15. **Hana:** For the kitchen, I thought we'd bring the mugs over and just use the dishwasher.
16. **Joel:** Fair enough. Anyway, the keys.
17. **Hana:** There are six sets of keys, and each team lead gets one.
18. **Joel:** The landlord keeps the spare set, and the cleaners have their own. **[L]**
19. **Hana:** The alarm company is coming on the Tuesday to show us the panel.
20. **Joel:** They said it only takes half an hour, so anyone who's around can come.
21. **Hana:** We'll put a sign-in sheet by the front door for the first week.
22. **Joel:** We could start carrying the small things over on the twenty-seventh, to get ahead. **[U3]**
23. **Hana:** I'll leave the spare boxes in the corridor for now. _(pause 3 s)_
24. **Joel:** Great. I think that's most of the move covered now, which is a real relief, honestly.
25. **Hana:** The labels, the spare tape and the marker pens are all in the cupboard by the door. **[X]**
26. **Joel:** The crates have to go back to the hire company within a week of the move.
27. **Hana:** Is there anything else before we finish? _(pause 5 s)_
28. **Joel:** Then the next meeting is Tuesday the eighteenth, at two, in the meeting room.

### R-B: Autumn concert

Speakers: Bea and Tomas, of a community choir committee.

Notes card (show for two minutes): **Your notes from the last meeting, 2 October**

- The church hall isn't free on Friday evenings because of bell-ringing practice.
- The piano tuner needs two weeks' notice.
- Tomas's section has fourteen singers, not twelve.
- The school prints the programmes for free.
- Ticket sales close at five the day before.
- Interval drinks budget: £80.
- Only the caretaker can change the church lights, and he's away until the Friday.

1. **Bea:** Thanks for coming. The autumn concert is on Saturday the thirteenth, in St Anne's church, and we're nearly ready.
2. **Tomas:** Rehearsals have gone well. There are thirty-eight singers coming, mostly from the old choir.
3. **Bea:** I've booked the church hall for the dress rehearsal on Friday evening, so nobody has to take time off. **[U1]**
4. **Tomas:** The conductor said the run-through will take about three hours. _(pause 3 s)_
5. **Bea:** And the school's printing the programmes again for free, so that's one less thing to pay for.
6. **Tomas:** The posters went up on the Monday, and the radio advert runs from the Friday.
7. **Bea:** Good. Now, tickets.
8. **Tomas:** People will want to buy tickets on the day, so we'll need to tell the box office.
9. **Bea:** Sales close at five the day before, so I told the box office this morning. **[RD]**
10. **Tomas:** There are a hundred and twenty seats, and the gallery holds another thirty people.
11. **Bea:** The church has a hearing loop as well, for anyone who needs it during the performance itself.
12. **Tomas:** The old risers are too wobbly to use, so they're going to the tip.
13. **Bea:** For staging, we'll set out twelve chairs for Tomas's section. **[U2]** _(pause 3 s)_
14. **Tomas:** The music stands are fine, so we're keeping all of them.
15. **Bea:** For the piano, I thought we'd ring the tuner a few days before the concert.
16. **Tomas:** Fair enough. Anyway, the doors.
17. **Bea:** There are four stewards, and each one looks after a door.
18. **Tomas:** The vicar keeps the spare keys, and the caretaker has his own. **[L]**
19. **Bea:** The fire officer is coming on the Wednesday to check the exits.
20. **Tomas:** She said it only takes half an hour, so anyone who's around can come.
21. **Bea:** We'll put a collection bucket by the main door for the interval.
22. **Tomas:** We could rig the stage lights on the Thursday, to get ahead. **[U3]**
23. **Bea:** I'll leave the spare cables in the vestry for now. _(pause 3 s)_
24. **Tomas:** Great. I think that's most of the concert covered now, which is a real relief, honestly.
25. **Bea:** The name badges, the spare pens and the lanyards are all in the box by the vestry door. **[X]**
26. **Tomas:** The chairs have to go back to the school within a week of the concert.
27. **Bea:** Is there anything else before we finish? _(pause 5 s)_
28. **Tomas:** Then the next meeting is Monday the twenty-second, at eight, in the vestry.

### Reminder cue schedules

Each reminder is shown with the label "From your notes, 3 March. Not from this conversation." (R-A) or "From your notes, 2 October. Not from this conversation." (R-B).

| Cue | After line | Kind                                                                               | R-A reminder text                                                                       | R-B reminder text                                                                |
| --- | ---------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| U1  | 3          | Useful                                                                             | The lift is out of service at weekends, so movers can't use it on a Saturday or Sunday. | The church hall isn't free on Friday evenings because of bell-ringing practice.  |
| RD  | 9          | Redundant: line 9 has just said it                                                 | Parking permits at the new building take ten working days.                              | Ticket sales close at five the day before.                                       |
| U2  | 13         | Useful                                                                             | Joel's team needs eight desks, not six.                                                 | Tomas's section has fourteen singers, not twelve.                                |
| L   | 18         | Late: the topic changed at line 16, about 11 seconds earlier at 150 words a minute | The new kitchen has no dishwasher until April.                                          | The piano tuner needs two weeks' notice.                                         |
| U3  | 22         | Useful                                                                             | The new office is handed over on the 28th; nobody can go in before then.                | Only the caretaker can change the church lights, and he's away until the Friday. |
| X   | 25         | Unsupported: the card says £60 / £80                                               | Leaving-do budget: £100.                                                                | Interval drinks budget: £150.                                                    |

### Reminder answer cards

| When the participant raises …         | R-A reply                                                | R-B reply                                                |
| ------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| U1                                    | Hana: "Oh, good catch. I'll ask the firm for a weekday." | Bea: "Oh, good catch. I'll ask about another evening."   |
| U2                                    | Joel: "You're right, it's eight. I'll change the order." | Tomas: "You're right, it's fourteen. I'll set out more." |
| L                                     | Hana: "Ah, true. Paper cups for a while, then."          | Bea: "Ah, true. I'll ring the tuner this week."          |
| U3                                    | Joel: "Ah, true. We'll wait until the handover."         | Tomas: "Ah, true. We'll wait for the caretaker."         |
| the unsupported figure                | Hana: "I think it was sixty."                            | Bea: "I think it was eighty."                            |
| the line 9 point before line 9        | Hana says line 9 as the reply                            | Bea says line 9 as the reply                             |
| the line 9 point after line 9 said it | Hana: "Yes, I've applied already."                       | Bea: "Yes, I've told them already."                      |
| anything else                         | "Good question, let's check that after."                 | same                                                     |
| a comment without a question          | "Mm, yes."                                               | same                                                     |

## Counterbalancing schedule

Participant _n_ uses sequence ((_n_ − 1) mod 8) + 1. "Cues" means the assisted schedule; "none" means the blank deck.

| Sequence | 1st       | 2nd       | 3rd       | 4th       |
| -------- | --------- | --------- | --------- | --------- |
| 1        | Q-A, cues | Q-B, none | R-A, none | R-B, cues |
| 2        | Q-A, none | Q-B, cues | R-B, cues | R-A, none |
| 3        | Q-B, cues | Q-A, none | R-B, none | R-A, cues |
| 4        | Q-B, none | Q-A, cues | R-A, cues | R-B, none |
| 5        | R-B, cues | R-A, none | Q-A, cues | Q-B, none |
| 6        | R-B, none | R-A, cues | Q-A, none | Q-B, cues |
| 7        | R-A, cues | R-B, none | Q-B, cues | Q-A, none |
| 8        | R-A, none | R-B, cues | Q-B, none | Q-A, cues |

Across the eight sequences:

- each conversation is assisted in four sequences and unassisted in four;
- each conversation is heard first within its pair four times;
- each part comes first four times;
- the assisted conversation of each pair falls in each of the four session positions twice.

## Session runbook

| Step                          | Minutes | What happens                                                                                                 |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| Welcome and consent           | 8       | Read the information sheet together; the participant ticks the consent statements. Confirm recording is off. |
| Brief and practice            | 4       | Read the brief; run the practice conversation.                                                               |
| Part 1, conversation 1        | 3 + 4   | Conversation, then comprehension, orientation (reminder pair only) and self-report questions.                |
| Part 1, conversation 2        | 3 + 4   | As above.                                                                                                    |
| Break                         | 3       |                                                                                                              |
| Part 2, conversations 3 and 4 | 14      | As above.                                                                                                    |
| Notes cards                   | 4       | Two minutes before each reminder conversation, whichever part it falls in.                                   |
| Debrief                       | 5       | Explain that some prompts were deliberately wrong or late; answer questions; remind them how to withdraw.    |

Total about 55 minutes. The facilitator fills the coding sheet live during each conversation and notes any deviation, such as a skipped line or a reader improvising.

## Measures and scoring

### Useful participation (coded live, content only)

For each open item the facilitator ticks one box: **in time**, **later**, or **not raised**. The item counts as raised when the participant:

- asks about it in any words;
- proposes an answer ("Could we do printed ones?");
- offers to take it on ("I can collect them");
- or, in the reminder pair, states or asks about the conflicting note ("Isn't the lift closed at weekends?").

Wording, fluency, tone and length do not matter.

Also ticked:

- **Unsupported, accepted:** the participant treats the unsupported cue as true ("Who's getting the banner?", "So we've got £100 for the leaving do").
- **Unsupported, checked:** the participant questions or corrects it ("Is there a banner?", "Wasn't it £60?"). This is coded separately and is not uptake.
- **Re-asked:** the participant asks the already-answered point after line 9 has given it. Asking it before line 9 is recorded as neutral.
- **Other turns:** a count of other contributions, recorded but not scored as good or bad.

The primary participation outcome for each conversation is the number of useful items raised **in time**: U1, U2 and U3, scored 0 to 3. Items raised later and the late item L are reported separately. Speaking is optional, so a score of 0 is not a failure by the participant. Understanding without speaking is useful participation too, which is why comprehension and orientation are always reported beside it.

### Listening comprehension

Eight multiple-choice questions after each conversation, answered without time pressure, each with "It wasn't said" as a fifth option. Four are **near-cue** items, about a fact said in the line straight after a cue appears (lines 4, 10, 19 and 26). The other four are **other** items, at least three lines after the last cue to appear (lines 2, 6, 17 and 28). With a cue every 20 to 40 seconds, no line is far from every cue. The same positions are used in both conditions, so a listening cost when a cue arrives shows as a lower near-cue score with cues. Lines 6, 17 and 28 begin while the previous cue may still be on screen, 12 to 17 seconds after it appeared, so the contrast is between the moment a cue arrives and later moments, not between a cue on screen and none.

No near-cue fact is the answer to its cue or is restated by it. Two share the cue's topic, which is realistic but could prime recall slightly:

- line 4, about the collection the U1 cue asks about;
- line 10, about where the posters go, or about parking, just after a cue on the same subject.

No item depends on whether the participant spoke, and no answer card mentions a comprehension answer or distractor.

### Orientation (reminder pair only)

One question after each reminder conversation: "Going by your notes, which of these plans from the meeting would run into a problem? Tick any that apply." Six plans are listed. Four conflict with a note (U1, U2, U3 and L) and two do not. Score the conflicting plans ticked (0 to 4) and, separately, the others ticked (0 to 2).

The question names plans, not notes, so the participant has to make the connection; a reminder shows the note but not the conflict. Orientation is still expected to come out higher with reminders, because that is the benefit being tested. It is reported as an outcome, not used as a guard against harm.

### Self-report

- **After every conversation:** "Did you think of anything you might have said or asked? Not speaking is completely fine." (yes, no or rather not say; what, optional).
- **After an assisted conversation only:**
  - For each prompt shown, from a printed list: helpful, not needed, wrong or confusing, didn't see it, or rather not say.
  - "Did any prompt make you miss something someone said?" (yes, no or not sure, and which).
- **At the end, optional:** which kind of help they would want in a real meeting (questions, reminders, both or neither), with a comment.

### Never recorded or inferred

The study scores what was said and when, against the script, and the answers a participant gives. It does not record or infer:

- emotion, mood or stress;
- attention, eye contact, gaze or "engagement";
- confidence, fluency, accent, speaking speed or competence;
- health, disability, neurotype or any diagnosis.

Nothing is inferred from silence. If a participant mentions any of these about themselves, it is not written down. No participant is ranked or described, and per-person rows appear only under random codes.

## Comprehension questions and answer key

The correct answer is marked ✓. Every comprehension question also offers "E. It wasn't said". In the orientation lists, ✓ marks the plans that conflict with a note; participants see the list without marks, in a shuffled order.

### Q-A

1. When does the community centre's office close on Fridays? A at two · B at three · **C at four ✓** · D at five (line 4)
2. Besides the library noticeboard and the station, where will the posters go? A the school gate · **B the bakery window ✓** · C the café · D the church porch (line 10)
3. When does the church want its tea urn back? A by noon on Saturday · **B by six on Saturday evening ✓** · C on Sunday morning · D on Monday (line 19)
4. From what time can setting up start? A seven · **B eight ✓** · C nine · D ten (line 26)
5. How many boxes of donations are in the storeroom? A 13 · B 21 · **C 31 ✓** · D 40 (line 2)
6. How much do hardbacks cost? A 50p · B £1 · **C £2 ✓** · D £3 (line 6)
7. What is the bakery giving? A a box of biscuits · **B two trays of scones ✓** · C a cake for the raffle · D bread rolls (line 17)
8. When is the next meeting? A Tuesday the 4th · **B Thursday the 6th ✓** · C Thursday the 13th · D Saturday the 22nd (line 28)

### Q-B

1. Until when is the sports club's shed open on Saturdays? A nine · B ten · **C eleven ✓** · D noon (line 4)
2. Besides the school gate and the swimming pool, where will the leaflets go? A the library · **B the newsletter ✓** · C the café · D the bus stop (line 10)
3. When do the scouts want their gazebo back? A by noon on Sunday · **B by five on Sunday afternoon ✓** · C the next weekend · D on Monday (line 19)
4. From what time can setting up start? A six · **B seven ✓** · C eight · D nine (line 26)
5. How many children are registered? A 16 · B 36 · **C 46 ✓** · D 64 (line 2)
6. What is the entry price for a family? A £3 · **B £5 ✓** · C £6 · D free (line 6)
7. What is the supermarket giving? **A six packs of bottled water ✓** · B a box of bananas · C two crates of squash · D paper cups (line 17)
8. When is the next meeting? A Monday the 8th · **B Wednesday the 3rd ✓** · C Wednesday the 10th · D Sunday the 14th (line 28)

### R-A

1. How long did the removal firm say the move would take? A about two hours · B about three hours · **C about five hours ✓** · D a whole weekend (line 4)
2. How many parking spaces are there? A 6 · **B 12 ✓** · C 20 · D 28 (line 10)
3. When is the alarm company coming? A Monday · **B Tuesday ✓** · C Thursday · D Friday (line 19)
4. When do the crates have to go back? A on the day of the move · **B within a week of the move ✓** · C within ten working days · D at the end of next month (line 26)
5. How many crates are packed already? A 25 · B 42 · **C 52 ✓** · D 62 (line 2)
6. When do the phones switch over? A the Friday before · B the Saturday · **C the Monday morning ✓** · D the Tuesday (line 6)
7. How many sets of keys are there? A four · B five · **C six ✓** · D ten (line 17)
8. When is the next meeting? A Monday the 18th · **B Tuesday the 18th ✓** · C Tuesday the 28th · D Thursday the 8th (line 28)

Orientation: "Going by your notes, which of these plans from the meeting would run into a problem? Tick any that apply."

- moving on Saturday the twenty-ninth ✓
- ordering six new desks for Joel's team ✓
- using the dishwasher in the new kitchen ✓
- carrying the small things over on the twenty-seventh ✓
- applying for the parking permits this morning
- giving each team lead a set of keys

### R-B

1. How long will the run-through take? A about two hours · **B about three hours ✓** · C about four hours · D about five hours (line 4)
2. How many seats are there, not counting the gallery? A 30 · B 100 · **C 120 ✓** · D 140 (line 10)
3. When is the fire officer coming? A Monday · B Tuesday · **C Wednesday ✓** · D Thursday (line 19)
4. When do the chairs have to go back to the school? A the day after · **B within a week of the concert ✓** · C within two weeks · D at the end of the month (line 26)
5. How many singers are coming? A 28 · B 33 · **C 38 ✓** · D 48 (line 2)
6. From when does the radio advert run? A the Monday · B the Wednesday · **C the Friday ✓** · D the Saturday (line 6)
7. How many stewards are there? A two · B three · **C four ✓** · D six (line 17)
8. When is the next meeting? **A Monday the 22nd ✓** · B Tuesday the 22nd · C Monday the 12th · D Saturday the 13th (line 28)

Orientation: "Going by your notes, which of these plans from the meeting would run into a problem? Tick any that apply."

- the dress rehearsal on Friday evening ✓
- setting out twelve chairs for Tomas's section ✓
- ringing the piano tuner a few days before the concert ✓
- rigging the stage lights on the Thursday ✓
- telling the box office this morning
- having each steward look after a door

## Analysis and decision rules

For each participant and each pair, compare the assisted conversation with the unassisted one on:

- **in-time useful items raised** (0 to 3);
- **near-cue comprehension** (0 to 4) and **other comprehension** (0 to 4);
- in the reminder pair, **orientation** (conflicting plans ticked, 0 to 4, with other plans ticked reported beside it);
- the late item raised at all, with and without cues.

Record each comparison as **more**, **same** or **fewer** with cues. Across _n_ participants, _m_ is the number with more, _f_ the number with fewer and _t_ the number tied. Report per-pair tallies and per-participant rows under random codes, without sequence numbers or dates. Also report counts of accepted and checked unsupported cues, re-asked points, late-item raises and "missed speech" answers. Do not combine participation and comprehension into one score.

The thresholds below are for the planned eight participants, with the values for a second rotation of sixteen in brackets.

| Decision                          | Rule, fixed before the first session                                                                                                                                                                                                                                                                                                                                                   | What it changes                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1 Questions**                  | **Favourable** if _m_ ≥ 5 (10) and _f_ ≤ 1 (2) on in-time items in the question pair, and D3's run-level trigger has not fired for that pair. **Unfavourable** if _m_ ≤ _f_ and _t_ ≤ 4 (9). **Uninformative** if _t_ ≥ 5 (10), for example when almost nobody speaks in either condition or everyone raises every item. **Inconclusive** otherwise.                                   | Favourable: worth the next step, comparing an evaluator against these human-selected cues (V12). This does not show that automatic cues would help. Unfavourable: no sign of added value from this question format in this setup, so try a revised format or timing, or the simpler manual interaction in V10, before more detection work. Uninformative: revise the open items, for example how clearly each one is left open, before drawing anything from them.      |
| **D2 Reminders**                  | The same thresholds on in-time conflicts raised in the reminder pair, with D3's run-level trigger not fired for that pair. Orientation is reported beside it, not used as a condition.                                                                                                                                                                                                 | Favourable: worth the next step for reminders (V6). Unfavourable: no sign of added value from reminders in this setup; revise before building more.                                                                                                                                                                                                                                                                                                                     |
| **D3 Listening cost (stop rule)** | **After every session:** pause if the participant answers "yes" to "Did any prompt make you miss something someone said?". "Not sure" is recorded but does not pause. **Over the run, checked on the running count after every session:** a trigger if, in either pair, participants with lower near-cue comprehension with cues outnumber those with higher by 4 or more (6 or more). | Pause scheduling and write up the finding. The owner decides whether to continue unchanged or revise; a revision restarts the count. A run-level trigger means revising the cue format before any automation, whatever D1 and D2 say. This applies the stop rule in the [pilot criteria](pilot-acceptance.md#user-value). Other comprehension is reported too; near-cue items are used because the risk is at cue arrival, and other items also reflect general recall. |
| **D4 Wrong cues**                 | Unsupported cues accepted by 3 or more of 8 (6 of 16) in a pair, or the already-answered or redundant point re-asked by 3 or more (6).                                                                                                                                                                                                                                                 | Treat display precision as a release gate: the owner sets a strict false-display threshold for V12 before any automated cue reaches people. Acceptance by one or none shows only that people warned that prompts may be wrong can filter them; it does not show that a product's users would.                                                                                                                                                                           |
| **D5 Late cues**                  | Compare raising the late item at all, with and without cues, using D1's thresholds. Check the near-cue item at line 19 with D3's run-level margin.                                                                                                                                                                                                                                     | If the late item is raised more with cues and line 19 does not trigger, a cue shown after a topic change can still help, so revisit withdrawing questions on a topic change. If line 19 triggers, keep withdrawing them. If both happen, the listening-cost result wins.                                                                                                                                                                                                |

These are formative decision rules, not significance tests. For scale, with eight untied participants a one-sided sign test reaches the 5% level only at 7 of 8 in the same direction (_p_ ≈ 0.035). Six of 8 gives _p_ ≈ 0.14, and the D1 split of 5 to 1 with two ties gives _p_ ≈ 0.11. A favourable result means worth the next step, not proven.

The run-level margin of 4 was chosen so that noise alone rarely triggers it. If each comprehension item is answered correctly with a probability between 0.75 and 0.9 and cues make no difference, a margin of 4 among eight participants triggers in either pair about 7% to 13% of the time. A margin of 3 would trigger about 19% to 27% of the time. This is a simple model, not a property of real participants.

### Minimum and maximum number of sessions

- **Minimum: eight counted sessions**, one per counterbalancing sequence, plus one rehearsal with a volunteer whose data is not kept. The [pilot criteria](pilot-acceptance.md#user-value) use six as a placeholder; six would leave two sequences unused and the design unbalanced, so this protocol proposes eight.
- **If the result is inconclusive**, add one more rotation of eight (16 in total), using the bracketed thresholds. **Do not add sessions beyond 16** to chase a result.
- A run that triggers D3 is written up whatever the count.

## Consent and data handling

### Information sheet (summary to give participants)

> **What this is:** a test of short prompts that might help people during meetings. You will listen to four short, made-up meetings over a video call and answer a few questions after each. It takes about an hour. **What we are testing:** the prompts, not you. **What we keep:** your answers to the questions and a note of which planned points you raised, under a code instead of your name. **What we don't keep:** no audio, video or screen recording, no transcript, no information about your health or background. **Your choices:** you can stop at any time without giving a reason, skip any question, and ask for your answers to be deleted until the results are combined on (date set by the owner). **Who sees it:** the person running your session and, if different, the project's owner. The two people reading the meeting parts hear the session live but do not see your answers. Combined results under a random code, with no names, and no quotes unless you agree below, may be published in the project's public repository. **Contact:** (owner's contact for questions and withdrawal).

### Consent statements (participant ticks each)

- I have read the information sheet and had my questions answered.
- I agree to take part, and I know I can stop at any time.
- I understand that no audio, video or screen recording will be made.
- I agree that my anonymous answers may be included in published combined results.
- Optional: I agree that a short quote of something I said may be used without my name. (Leave unticked to decline.)

### What is collected and how it is kept

| Data                                                                   | Collected?                                                                     | Where and how long (proposed; owner to confirm)                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Name and signature on the consent form                                 | Yes                                                                            | Kept apart from all study data, on paper in a locked place or a separate file; destroyed 12 months after the write-up |
| Participant code and sequence number                                   | Yes                                                                            | On the study sheets only                                                                                              |
| Coding sheet ticks, comprehension, orientation and self-report answers | Yes                                                                            | Paper, or a file on the owner's own device, outside this repository; raw sheets destroyed 90 days after the write-up  |
| A short paraphrase of what the participant asked                       | Only if useful, and no verbatim quote unless the optional statement was ticked | With the coding sheet                                                                                                 |
| Deviations from the script                                             | Yes                                                                            | With the coding sheet                                                                                                 |
| Audio, video, screen recording, call transcript                        | **No**                                                                         | Call recording, transcription and AI meeting features stay off                                                        |
| Age, gender, health, disability, neurotype or job                      | **No**                                                                         | Not asked; not written down if mentioned                                                                              |
| Any rating or judgment of the person                                   | **No**                                                                         | Comprehension answers are scored only to compare the two conditions, never to describe the person                     |
| Anything from the participant's own meetings, notes or devices         | **No**                                                                         | The study uses only the fictional materials here                                                                      |

- **Where data may not go.** Study data is never committed to this repository, uploaded to an AI service or review tool, or used to train or tune anything. Scoring is done by hand.
- **What may be published.** Combined results may be published in the repository after the run: per-pair tallies, per-participant rows under random codes (not the participant number, which would reveal the sequence) without sequence numbers or dates, and the decisions taken. With few participants drawn from people the owner knows, even coded rows could identify someone, so the owner may publish tallies only.
- **Withdrawal.** A participant who withdraws before the combined results are written has their sheets destroyed.
- **Ethics review.** This protocol is not an ethics approval. If the owner, a collaborator or the participants' organisation requires ethics review for studies with people, obtain it first.
- **Payment.** Whether participants are paid or thanked with a gift is the owner's decision, made the same way for everyone.

## Before the first counted session (owner checklist)

1. **Settle the open decisions** below and record them in this document with the date. Once the first counted session has run, do not change the decision rules for this run.
2. **Recruit and schedule.** Recruit participants and assign sequences in order of their first session.
3. **Brief the readers.** Find two readers and rehearse each conversation twice, aiming for about three minutes each; give the readers their copies without cue marks.
4. **Prepare the materials:**
   - five slide decks: four assisted decks and one blank deck, each cue slide set to auto-advance after 18 seconds;
   - the practice deck;
   - notes cards for R-A, R-B and the practice;
   - question sheets, self-report sheets, coding sheets and consent forms.
5. **Rehearse the whole session** once with a volunteer whose data is not kept. Fix timing problems, then freeze the materials.
6. **Check the call on the day.** Confirm before each session that recording, transcription and AI features are off.

## Open decisions for the owner

- Agree or change the decision rules D1 to D5, the minimum of eight sessions and the maximum of 16.
- Choose delivery option A now, or wait for an app build that can replay authored cues (option B).
- Decide who facilitates, who reads, and how participants are found.
- Set the retention periods, the date after which withdrawal can no longer remove data from combined results, and the contact for withdrawal.
- Decide whether participants are paid or thanked, and whether ethics review applies.
- Choose whether the reminder and question parts run in one session, as proposed, or separately.

## Limitations

- **Delivery varies.** Live reading varies between sessions; rehearsal and fixed answer cards limit this but do not remove it.
- **Coding is not blind.** One facilitator codes live and knows the condition. The coding asks only whether a planned item was raised, which limits judgment, but it is not blind. A second observer would help where one is available.
- **Order effects remain.** Seeing a prompt in the practice or an earlier conversation may change how someone listens in a later unassisted one. Counterbalancing spreads this effect, but it does not remove it.
- **Best-case cues.** Human-selected cues, shown the moment the trigger line ends, are a best case for content and timing. Automatic detection and live transcription delays would be worse.
- **Uneven windows.** The in-time window for U2 is about 7 to 9 seconds at the planned pace, against about 20 seconds or more for U1 and U3, so U2 is harder to raise in time in both conditions.
- **A narrow measure.** The participation outcome partly measures whether people voice a prompt they were shown. A higher count with cues does not by itself show better understanding, which is why comprehension and orientation are always reported beside it.
- **Wrong cues are labeled.** Participants are told that prompts may be wrong, which a product would not say each time. How often people accept a wrong cue may differ outside the study.
- **Reminders draw on a card.** The notes in the reminder pair were read two minutes before the conversation, not kept from a real earlier meeting.
- **Small and narrow.** Eight sessions in English with fictional volunteer-group meetings can expose problems and show a direction. They cannot establish general effectiveness or a benefit for any particular group.
