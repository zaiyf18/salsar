# Salsar — Vehicle Custody Log

A vehicle handover system where the **printed record and the electronic record must agree** — because the paper is what gets signed, and the signature is what makes it binding.

> **Demo data.** Every plate, name, identity number, chassis number and figure in this repository is fabricated. See `LICENSE` for terms — this is source-available for study, not licensed for use.

---

## What it does

- **Handover record** per vehicle: from, to, odometer, and a checklist of up to 120 items filtered by vehicle category.
- **Printed record** with a summary page and a full appendix, carrying a verification hash and a QR code.
- **Six languages.** The recipient's acknowledgement is presented in Arabic, English, Urdu, Hindi, Bengali or Nepali — the languages actually spoken by drivers in the Gulf. The Arabic text governs; the translation is reachable from a public page via an 8-digit access number printed under the QR.
- **Asset transfers** between vehicles, with their own record and translation.
- **Certification**: the signed paper is uploaded as a PDF, bound to the record, which then locks.
- **Document tracking**: registration, insurance and inspection expiry with warnings.

## The design decision that runs through everything

The results sheet is a **delta log, not a state log**. A row is written only when an item's status actually changes; the standing state of any item is derived by replaying deltas. This is enforced twice — in the browser and again on the server.

It matters because it is the source of the system's hardest bug: the print path once assumed that any item absent from a record's delta set was "no issue", so an item standing at "not applicable" — inherited from an earlier record and shown that way to the operator — printed as *no issue*. The appendix did not merely omit the fact; it asserted the opposite. Anyone editing the print path without understanding this decision will reintroduce it.

## Architecture

```
Officer's browser
   │  PHP session + Google sign-in (domain AND allowlisted address)
   ▼
public_html/*.php            shared hosting
   │  proxy attaching a shared bearer token
   ▼
Apps Script                  ANYONE_ANONYMOUS deployment, guarded by the token
   ▼
Google Sheets (14 tabs)  +  three Drive folders
```

The browser never talks to Apps Script directly; the token never leaves the server. `salsar-private/` sits **outside the web root**.

Google Sheets is not a database: no foreign keys, no transactions, no unique constraints. **Every integrity guarantee lives in the code** — writes take a `LockService` lock and carry a `clientRequestId` checked *inside* the lock, so a retry returns the first record instead of creating a second.

Full notes, including seven decisions and the known fragile points, are in `docs/`.

## Repository layout

| Folder | Deploys to |
|---|---|
| `Appscript/` | the Apps Script project |
| `Hostinger/public_html/` | the web root |
| `Hostinger/salsar-private/` | **outside** the web root, beside `public_html` |
| `docs/` | reference, not deployed |

## Status

Running in production on a 42-vehicle fleet. Current version 2.6.0.

Arabic README: `README.md`.

## Licence

**Apache License 2.0.** Use it, modify it, deploy it, build on it, sell it — under two conditions only:

- **Attribute**: keep the copyright notice and the `NOTICE` file in your copies.
- **State your changes**: if you modify the files, say that you did.

Two things the licence deliberately does not grant: the **name and logo** ("Salsar" / "سلسار") are outside it, and its **explicit patent grant** protects users and author alike.

Full text in `LICENSE`; notices in `NOTICE`.

## Disclaimer

Provided **"AS IS", without warranty of any kind**. The copyright holder accepts no liability for any damage arising from use or inability to use — **for ANY use, good or bad**, direct or indirect.

Because this system produces **records that get signed and may be relied upon**:

- No representation that its output is legally valid or acceptable to any authority or court in any jurisdiction.
- Verifying regulatory compliance is entirely the responsibility of **whoever deploys and operates it**.
- The acknowledgement texts and translations here are **working examples, not legal advice**.

Full bilingual text in `NOTICE`. This is not legal advice.

## Contact and suggestions

[Issues](https://github.com/zaiyf18/salsar/issues) — open one and it will be read.

## Keywords

`vehicle-custody · vehicle-handover · fleet-management · inspection-checklist · arabic-rtl · google-apps-script · google-sheets · php · multilingual · saudi-arabia`

سجل عهدة المركبات · محضر تسليم واستلام مركبة · إدارة أسطول · عهدة السائق · قائمة تشييك المركبات · محضر مصادق · ترجمة محضر · نظام عهدة · وثائق المركبة · الفحص الدوري
