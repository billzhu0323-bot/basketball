# Project Plan — Basketball Team Management Platform

> A web app for basketball coaches to manage their teams: practices, games,
> communication, and more.
>
> **How to use this doc:** Fill in each `_(fill in)_` placeholder and replace the
> prompt text under each heading. Delete guidance you don't need. Keep this file
> as the single source of truth for scope and decisions; link out to detailed
> docs where a section grows large.

- **Status:** Draft
- **Last updated:** _(fill in — date)_
- **Owner:** _(fill in — name)_

---

## 1. Vision & Goals

**One-sentence pitch:** _(fill in — what is this and who is it for?)_

**Problem it solves:** _(fill in — what pain do coaches have today? spreadsheets,
group texts, scattered tools?)_

**Goals (what success looks like):**
- _(fill in)_
- _(fill in)_

**Non-goals (explicitly out of scope, at least for v1):**
- _(fill in — e.g. live game stat-tracking, video analysis, payments?)_

---

## 2. Target Users & Personas

| Persona | Role / Needs | Key tasks in the app |
| ------- | ------------ | -------------------- |
| Head Coach | _(fill in)_ | _(fill in)_ |
| Assistant Coach | _(fill in)_ | _(fill in)_ |
| Player | _(fill in — will players have logins?)_ | _(fill in)_ |
| Parent / Guardian | _(fill in — youth teams?)_ | _(fill in)_ |
| Team Manager / Admin | _(fill in)_ | _(fill in)_ |

**Primary persona for v1:** _(fill in — who do we optimize for first?)_

**Context of use:** _(fill in — mobile courtside? desktop for planning? both?)_

---

## 3. Core Features

Group features by area. Mark each as **Must / Should / Could / Won't** (MoSCoW)
for v1 scoping.

### 3.1 Teams & Roster
- _(fill in — create teams, seasons, add/remove players, positions, jersey #s)_
- Priority: _(Must / Should / Could)_

### 3.2 Practices
- _(fill in — schedule practices, location, attendance, drills/plans, notes)_
- Priority: _(fill in)_

### 3.3 Games & Schedule
- _(fill in — schedule games, opponents, home/away, results, calendar view)_
- Priority: _(fill in)_

### 3.4 Communication
- _(fill in — announcements, direct/group messaging, notifications, RSVPs,
  email/SMS/push?)_
- Priority: _(fill in)_

### 3.5 Availability & Attendance
- _(fill in — players/parents mark availability, coach sees who's coming)_
- Priority: _(fill in)_

### 3.6 "And more" — candidate features
- _(fill in — stats, playbook/plays diagrams, lineups, payments/dues,
  documents, photos, season reports, awards?)_
- Priority: _(fill in — likely Could / Won't for v1)_

---

## 4. Scope: MVP vs. Later

**MVP (v1) — the smallest thing that's genuinely useful:**
- _(fill in)_

**Fast-follow (v1.1):**
- _(fill in)_

**Later / backlog:**
- _(fill in)_

---

## 5. Data Model (draft)

List the main entities and their key fields/relationships. Refine into a real
schema later.

| Entity | Key fields | Relationships |
| ------ | ---------- | ------------- |
| User | id, name, email, role | belongs to Team(s) |
| Team | id, name, season, level | has many Players, Events |
| Player | id, name, position, number | belongs to Team |
| Event (Practice/Game) | id, type, date, location, opponent | belongs to Team |
| Attendance / RSVP | id, status | links User ⇄ Event |
| Message / Announcement | id, body, author, timestamp | belongs to Team |
| _(fill in)_ | _(fill in)_ | _(fill in)_ |

**Open questions:** _(fill in — one user in multiple teams? multiple seasons?
roles per team vs. global?)_

---

## 6. Technical Approach

Decide and record. (Ask for a recommendation if unsure.)

- **Frontend:** _(fill in — e.g. React/Next.js, Vue, plain?)_
- **Backend / API:** _(fill in — e.g. Node/Express, Next.js API routes, Django,
  Rails, serverless?)_
- **Database:** _(fill in — e.g. PostgreSQL, SQLite, Firebase?)_
- **Auth:** _(fill in — email/password, magic link, Google/Apple SSO?)_
- **Notifications:** _(fill in — email provider, SMS, web push?)_
- **Hosting / Deploy:** _(fill in — Vercel, Netlify, Fly.io, AWS?)_
- **Mobile strategy:** _(fill in — responsive web only, PWA, native later?)_

**Key non-functional requirements:**
- _(fill in — mobile-first, offline courtside use, accessibility, privacy of
  minors' data, number of concurrent teams/users?)_

---

## 7. UX & Design Notes

- **Key screens:** _(fill in — dashboard, team page, schedule/calendar, event
  detail, roster, messages, settings)_
- **Navigation model:** _(fill in)_
- **Branding / look & feel:** _(fill in — colors, tone, logo?)_
- **Wireframes / references:** _(fill in — link to Figma, sketches, apps you
  like: TeamSnap, SportsEngine, etc.)_

---

## 8. Milestones & Rough Timeline

| Milestone | Deliverable | Target |
| --------- | ----------- | ------ |
| M0 — Setup | Repo, tooling, CI, skeleton app | _(fill in)_ |
| M1 — Teams & Roster | Create team, manage players | _(fill in)_ |
| M2 — Scheduling | Practices & games, calendar | _(fill in)_ |
| M3 — Communication | Announcements & RSVPs | _(fill in)_ |
| M4 — Polish & Deploy | Auth, notifications, launch | _(fill in)_ |

---

## 9. Risks & Open Questions

- _(fill in — handling data for minors/COPYPPA-style privacy concerns?)_
- _(fill in — do players/parents need accounts, or coach-only for v1?)_
- _(fill in — how are people invited to a team?)_
- _(fill in — solo project or team? time budget?)_

---

## 10. Decisions Log

Record notable decisions as you go so future-you knows the "why".

| Date | Decision | Rationale |
| ---- | -------- | --------- |
| _(fill in)_ | _(fill in)_ | _(fill in)_ |

---

## 11. Next Actions

- [ ] Fill in Vision & primary persona (Sections 1–2)
- [ ] Lock MVP feature list (Sections 3 & 4)
- [ ] Pick the tech stack (Section 6)
- [ ] _(fill in)_
