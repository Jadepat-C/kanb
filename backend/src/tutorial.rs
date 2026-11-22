//! "Getting started" board created by the system for every new user (and on request from the Boards page).
//! Each user gets their own copy, as Owner, so they can practise freely without affecting anyone else.

use axum::{Json, extract::State};
use chrono::{Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{AppState, auth::CurrentUser, boards::Board, error::AppResult, position};

struct Card {
    list: usize,
    title: &'static str,
    body: &'static str,
    priority: i16,
    /// index into the board's default statuses: 0 Normal, 1 Blocked, 2 Ready, 3 Done (counts as finished)
    status: usize,
    labels: &'static [usize],
    start_in_days: Option<i64>,
    due_in_days: Option<i64>,
    /// indexes of cards in this list that this card waits for
    waits_for: &'static [usize],
}

/// Defaults for the fields most cards leave alone.
const CARD: Card = Card {
    list: 1,
    title: "",
    body: "",
    priority: 0,
    status: 0,
    labels: &[0],
    start_in_days: None,
    due_in_days: None,
    waits_for: &[],
};

struct Content {
    name: &'static str,
    description: &'static str,
    lists: [&'static str; 3],
    labels: [(&'static str, &'static str); 2],
    cards: &'static [Card],
}

const EN: Content = Content {
    name: "👋 Getting started",
    description: "A guided tour created for you by the system. Play with it freely; archive or delete it when you're done.",
    lists: ["Start here", "Learn more", "Done"],
    labels: [("Tutorial", "#2f5bd3"), ("Tip", "#22c55e")],
    cards: &[
        // 0
        Card {
            list: 0,
            title: "Welcome! Open me first",
            body: r#"# Welcome 👋

This board is **your own copy** of the tutorial. Nothing you do here affects anyone else, so click, drag and edit freely.

## How it's organised
- **Boards** hold **columns**, and columns hold **cards**.
- A card has a description, status, priority, labels, people, start and due dates, attachments, comments and a history.
- Click a card to open it. Rest the mouse on one for a quick preview.
- Every board can be seen three ways: **Board**, **Calendar** and **Gantt** (top right).

## Finished means "Done"
The bar next to the board name counts cards whose **status** is *Done*, wherever they are. Moving a card into the Done column doesn't finish it by itself; set its status too. (Board settings → Statuses decides which statuses count as finished.)

## Try this
- [ ] Open your picture (top right) and switch **Language** and **Theme**
- [ ] Open the next card: *"Cards are Markdown"*
- [ ] Drag this card to **Done** and set its status to *Done*
"#,
            ..CARD
        },
        // 1
        Card {
            list: 0,
            title: "Cards are Markdown",
            priority: 1,
            body: r#"# Writing in cards

The description works like **Obsidian**: Markdown renders as you type, and the raw syntax only shows on the line you're editing. Click anywhere in this text to see it.

## Formatting
**Bold**, *italic*, ~~strikethrough~~, `inline code` and [links](https://www.markdownguide.org/basic-syntax/) (Ctrl+click to open).

> Quotes look like this.

```sql
SELECT * FROM tasks WHERE done = false;
```

| Tables | work |
|---|---|
| too | ✓ |

## Checklists
Tick these; the card shows its progress (e.g. 1/3) on the board.
- [ ] Tick me
- [ ] And me
- [ ] Type `- [ ] ` on a new line to add another

## Good to know
- Use the **toolbar** above the editor or shortcuts: Ctrl+B, Ctrl+I, Ctrl+E (code), Ctrl+K (link).
- **Paste a screenshot** (Ctrl+V) or drop an image into the text: it's uploaded and shown inline.
- Changes **save automatically** a moment after you stop typing.
"#,
            ..CARD
        },
        // 2
        Card {
            list: 0,
            title: "Moving cards, and the ⋯ menu",
            body: r#"# Moving things around
- **Drag a card** to another column or up and down within one. On a phone or tablet, **press and hold** the card a moment, then drag.
- **Drag a column** by its header grip (⠿) to reorder columns.
- **Sort a column** from its ⋯ menu: by priority, due date, newest, title…

# Every action is one click away
- **Right-click a card** (or open it and press **⋯** at the top): rename, duplicate, move, status, priority, due date, labels, colour, save as template, add to your calendar, archive or delete.
- **Right-click a column**: new card, fold, sort, rename, WIP limit.
- **Right-click a board** on the Boards page: open, rename, colour, archive, delete.
- **Right-click a day** in the calendar: create a card on that day.

- [ ] Give this card a colour from its menu
"#,
            ..CARD
        },
        // 3
        Card {
            list: 0,
            title: "Search and filters",
            labels: &[1],
            body: r#"# Finding things
- Press **Ctrl+K** anywhere (or click the search box at the top) to search every board you can see, by title, description or card number (`#12`). Thai works too.
- On a board, **Filter cards…** narrows what you see instantly, in all three views.
- **Filters** narrows by status, priority and due date; **Labels** and **Assigned to me** do what they say.
- The Boards page can be filtered by name and by owner.

- [ ] Press Ctrl+K and search for "Gantt"
"#,
            ..CARD
        },
        // 4
        Card {
            title: "Status, priority, labels and dates",
            priority: 2,
            status: 1,
            labels: &[1],
            due_in_days: Some(1),
            body: r#"# Card details
This card is set up as an example: **2 stars**, status **Blocked**, the **Tip** label and **due tomorrow**.

- **Status** is the coloured dot. Statuses belong to the board and can be changed in *Board settings → Statuses*; tick **Done** on the ones that mean finished. The thin bar under each column header shows the mix of statuses.
- **Priority** is 0–3 stars.
- **Labels** belong to the board; their colour runs along the top of the card.
- **Start date** and **due date**: overdue cards turn red, and finished cards never count as overdue.
- **People**: anyone who's a member of the board.

- [ ] Change this card's status to *Ready*
"#,
            ..CARD
        },
        // 5
        Card {
            title: "Board, Calendar and Gantt views",
            start_in_days: Some(-1),
            due_in_days: Some(3),
            body: r#"# Three ways to see a board
Switch with **Board · Calendar · Gantt** at the top right. Filters apply to all three.

## Calendar
- **Drag** a card to another day to reschedule it (its time is kept), or onto **No due date** to clear it.
- Create a card with **New card**, by **double-clicking** a day, or from a day's right-click menu.
- **Calendar** in the top bar shows cards from *all* your boards at once.

## Gantt
- Each card with dates is a bar from its start to its due date. This card and the next one are examples.
- **Drag a bar** to move it, **drag its edges** to change the dates, and drag the **dot at its end** onto another card to make that card wait for this one.
- Switch **Day / Week / Month**, show **Assignees** and **Labels**, jump with **Today** and **Go to date**, or drag the date header to move through time.

- [ ] Open the Gantt view and stretch this card's bar by a day
"#,
            ..CARD
        },
        // 6
        Card {
            title: "Dependencies: this card waits for another",
            start_in_days: Some(4),
            due_in_days: Some(6),
            waits_for: &[5],
            body: r#"# Waiting for other cards
This card **waits for** *"Board, Calendar and Gantt views"*: it can't really start until that one is finished.

- Open a card and use **Waits for → Add**, or draw the link on the Gantt chart.
- On the board, a card with unfinished prerequisites shows a 🔗 count.
- On the Gantt chart the link is an arrow. It turns **red** when a card is scheduled to start before what it waits for is due.

- [ ] In the Gantt view, drag the previous card's bar past this one's start and watch the arrow turn red
"#,
            ..CARD
        },
        // 7
        Card {
            title: "Attachments and previews",
            body: r#"# Files
- Drop files onto an open card, or use **Upload file**.
- Click an attachment to **preview** it without downloading: images, PDF, Word, Excel/CSV, PowerPoint, text and code, video and audio. Use ← → to flip through them.
- Files are private: they're only served to people who can see the board.

- [ ] Attach any file to this card and preview it
"#,
            ..CARD
        },
        // 8
        Card {
            title: "Comments, @mentions and live updates",
            body: r#"# Working together
- Write a comment at the bottom of a card (Markdown and pasted images work here too). **Ctrl+Enter** posts it.
- Type **@** and a name to **mention** someone: they get a notification.
- Every change is logged in the same timeline: moves, status, dates, labels, attachments and more. Untick **Activity** to see only comments.
- Changes from other people appear **live**. The board header shows who else is here (green = viewing, amber = typing), and a card someone has open shows their picture.

- [ ] Leave a comment on this card
"#,
            ..CARD
        },
        // 9
        Card {
            title: "Notifications",
            labels: &[1],
            body: r#"# Never miss a thing
You're notified when you're **assigned** to a card, **@mentioned**, when someone **comments** on your cards, and when your cards are **due within 24 hours** or **overdue**.

- The **bell** at the top shows them all.
- **Profile → Notifications** chooses where else they go:
  - **email**
  - **browser notifications** on this device (phones too), even when Kanb isn't open
  - **chat apps**: Discord, Slack, Microsoft Teams, Google Chat, Telegram, LINE, ntfy, Gotify or any webhook
- A board can also post its activity to a **team channel**: *Board settings → Notifications*.

Which of these are available is decided by your admin.
"#,
            ..CARD
        },
        // 10
        Card {
            title: "Templates and recurring cards",
            body: r#"# Don't type the same thing twice
- **Card templates**: save any card as a template from its menu (**Save as template**). Use one from a column's ⋯ menu or the **New card** dialog. Manage them in *Board settings → Templates*.
- **Recurring cards**: in *Board settings → Templates → Recurring cards*, create a card from a template every day, week or month, e.g. a report every Monday at 09:00.
- **Board templates**: *Board settings → General → Save as board template* keeps the columns, statuses, labels and card templates. Pick it when you create a new board. The **Templates** page in the top bar lists all of them.
"#,
            ..CARD
        },
        // 11
        Card {
            title: "Your calendar app",
            due_in_days: Some(7),
            body: r#"# Dates in Google, Apple or Outlook Calendar
- **Profile → Calendar feed → Create my calendar link**, then subscribe to it in your calendar app. It updates by itself.
- Choose what it shows: your whole app, or **only what you choose** (ticked boards, plus single cards).
- Add a single card with **Add to my calendar** in the card or its menu. Cards in your feed show a small calendar icon.
- Keep the link private: anyone who has it can see those titles and dates. **New link** replaces it.
"#,
            ..CARD
        },
        // 12
        Card {
            title: "People, roles and permissions",
            labels: &[1],
            body: r#"# Who can do what
- There's no public sign-up. A **super admin** creates accounts: your picture (top right) → **Admin** → **Users**. They can also set up email and notifications for everyone.
- Whoever creates a board is its **Owner**.
- In **Board settings → Members** you add people with a role: *Owner, Admin, Editor, Commenter* or *Viewer*.
- **Roles & permissions** is a list of permissions per role, grouped by topic. Change it per board, or create your own roles.
"#,
            ..CARD
        },
        // 13
        Card {
            title: "Your account and two-factor sign-in",
            labels: &[1],
            body: r#"# Profile
Your picture (top right) → **Profile**:
- **Account**: picture, name, email (for password resets and notifications) and colour.
- **Security**: change your password, and turn on **two-factor sign-in** with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…). Keep the recovery codes somewhere safe.
- **Notifications** and **Calendar feed**: see the cards above.

Language and theme are right in the menu under your picture.

- [ ] Turn on two-factor sign-in
"#,
            ..CARD
        },
        // 14
        Card {
            title: "Archive, export and delete",
            labels: &[1],
            body: r#"# Cleaning up
- **Archive** hides a card, column or board but keeps everything. Restore it any time:
  - archived cards: **Board settings → Archive**
  - archived boards: **Boards page → Archived**
- **Export** a board from *Board settings → General*: a spreadsheet (CSV), the full data (JSON), or everything including attached files (ZIP).
- **Delete permanently** removes it for good: comments, history and **attachments, including the stored files**. This can't be undone.

When you've finished the tour, archive or delete this board. You can get a fresh copy from the Boards page: right-click the page → *Add tutorial board*.
"#,
            ..CARD
        },
        // 15
        Card {
            title: "On your phone or tablet",
            labels: &[1],
            body: r#"# Kanb fits in your pocket
- **Press and hold** a card, then drag it. A normal swipe scrolls.
- In an open card, **⋯** at the top has every action from the right-click menu.
- The calendar shows a dot for each card; **tap a day** to list its cards.
- In the Gantt view, swipe to scroll and tap a bar to open its card.
- **Install it like an app**: in your browser's menu choose *Add to Home Screen* or *Install app*. On an iPhone or iPad, that's also what lets Kanb send notifications.
"#,
            ..CARD
        },
        // 16
        Card {
            list: 2,
            title: "Keyboard shortcuts",
            status: 3,
            labels: &[1],
            body: r#"| Keys | What it does |
|---|---|
| Ctrl+K | Search everything (in the editor: insert a link) |
| Enter | Open the focused card |
| Ctrl+Enter | Post a comment / save |
| Ctrl+B / I / E | Bold / italic / code |
| Esc | Close dialogs |
| ← → | Previous / next file in the preview |

This card's status is *Done*, so it counts in the progress bar next to the board name.
"#,
            ..CARD
        },
    ],
};

const TH: Content = Content {
    name: "👋 เริ่มต้นใช้งาน",
    description: "บอร์ดแนะนำการใช้งานที่ระบบสร้างให้คุณ ลองเล่นได้ตามสบาย เสร็จแล้วจะเก็บหรือลบทิ้งก็ได้",
    lists: ["เริ่มที่นี่", "เรียนรู้เพิ่มเติม", "เสร็จแล้ว"],
    labels: [("บทเรียน", "#2f5bd3"), ("เคล็ดลับ", "#22c55e")],
    cards: &[
        // 0
        Card {
            list: 0,
            title: "ยินดีต้อนรับ! เปิดการ์ดนี้ก่อน",
            body: r#"# ยินดีต้อนรับ 👋

บอร์ดนี้เป็น **สำเนาส่วนตัวของคุณ** สิ่งที่ทำในนี้ไม่กระทบคนอื่น คลิก ลาก หรือแก้ไขได้เต็มที่

## โครงสร้าง
- **บอร์ด** มี **คอลัมน์** และในคอลัมน์มี **การ์ด**
- การ์ดมีรายละเอียด สถานะ ความสำคัญ ป้ายกำกับ ผู้รับผิดชอบ วันเริ่มและกำหนดส่ง ไฟล์แนบ ความคิดเห็น และประวัติการเปลี่ยนแปลง
- คลิกการ์ดเพื่อเปิด หรือวางเมาส์ค้างไว้เพื่อดูตัวอย่างแบบย่อ
- ทุกบอร์ดดูได้ 3 แบบ: **บอร์ด** **ปฏิทิน** และ **แกนต์** (มุมขวาบน)

## "เสร็จ" คือสถานะ
แถบข้างชื่อบอร์ดนับการ์ดที่มี **สถานะ** *เสร็จแล้ว* ไม่ว่าจะอยู่คอลัมน์ไหน การลากการ์ดไปคอลัมน์ "เสร็จแล้ว" อย่างเดียวยังไม่นับว่าเสร็จ ต้องเปลี่ยนสถานะด้วย (กำหนดได้ที่ ตั้งค่าบอร์ด → สถานะ ว่าสถานะไหนนับว่าเสร็จ)

## ลองทำ
- [ ] คลิกรูปโปรไฟล์ (มุมขวาบน) แล้วเปลี่ยน **ภาษา** และ **ธีม**
- [ ] เปิดการ์ดถัดไป: *"การ์ดเขียนด้วย Markdown"*
- [ ] ลากการ์ดนี้ไปที่ **เสร็จแล้ว** และเปลี่ยนสถานะเป็น *เสร็จแล้ว*
"#,
            ..CARD
        },
        // 1
        Card {
            list: 0,
            title: "การ์ดเขียนด้วย Markdown",
            priority: 1,
            body: r#"# การเขียนในการ์ด

ช่องรายละเอียดทำงานแบบ **Obsidian**: Markdown แสดงผลทันทีขณะพิมพ์ และจะเห็นสัญลักษณ์ดิบเฉพาะบรรทัดที่กำลังแก้ไข ลองคลิกที่ข้อความนี้ดู

## การจัดรูปแบบ
**ตัวหนา**, *ตัวเอียง*, ~~ขีดฆ่า~~, `โค้ด` และ [ลิงก์](https://www.markdownguide.org/basic-syntax/) (กด Ctrl ค้างแล้วคลิกเพื่อเปิด)

> ข้อความอ้างอิงหน้าตาแบบนี้

```sql
SELECT * FROM tasks WHERE done = false;
```

| ตาราง | ก็ได้ |
|---|---|
| เช่นกัน | ✓ |

## เช็กลิสต์
ลองติ๊กดู การ์ดจะแสดงความคืบหน้า (เช่น 1/3) บนบอร์ด
- [ ] ติ๊กฉัน
- [ ] ฉันด้วย
- [ ] พิมพ์ `- [ ] ` ขึ้นบรรทัดใหม่เพื่อเพิ่มรายการ

## ควรรู้
- ใช้ **แถบเครื่องมือ** ด้านบนหรือคีย์ลัด: Ctrl+B, Ctrl+I, Ctrl+E (โค้ด), Ctrl+K (ลิงก์)
- **วางภาพหน้าจอ** (Ctrl+V) หรือลากรูปมาวาง รูปจะอัปโหลดและแสดงในข้อความทันที
- **บันทึกอัตโนมัติ** หลังหยุดพิมพ์ครู่หนึ่ง
"#,
            ..CARD
        },
        // 2
        Card {
            list: 0,
            title: "การย้ายการ์ด และเมนู ⋯",
            body: r#"# การย้าย
- **ลากการ์ด** ไปคอลัมน์อื่น หรือขึ้นลงในคอลัมน์เดิม บนโทรศัพท์หรือแท็บเล็ต ให้ **กดค้าง** ที่การ์ดครู่หนึ่งแล้วค่อยลาก
- **ลากคอลัมน์** ที่จุดจับ (⠿) บนหัวคอลัมน์เพื่อสลับลำดับ
- **เรียงการ์ด** จากเมนู ⋯ ของคอลัมน์: ตามความสำคัญ กำหนดส่ง ใหม่สุด ชื่อ…

# ทุกคำสั่งอยู่ใกล้มือ
- **คลิกขวาที่การ์ด** (หรือเปิดการ์ดแล้วกด **⋯** ด้านบน): เปลี่ยนชื่อ ทำสำเนา ย้าย สถานะ ความสำคัญ กำหนดส่ง ป้ายกำกับ สี บันทึกเป็นเทมเพลต เพิ่มในปฏิทินของฉัน เก็บ หรือลบ
- **คลิกขวาที่คอลัมน์**: การ์ดใหม่ ย่อ เรียง เปลี่ยนชื่อ จำกัดจำนวนงาน (WIP)
- **คลิกขวาที่บอร์ด** ในหน้าบอร์ด: เปิด เปลี่ยนชื่อ สี เก็บ ลบ
- **คลิกขวาที่วัน** ในปฏิทิน: สร้างการ์ดในวันนั้น

- [ ] ใส่สีให้การ์ดนี้จากเมนู
"#,
            ..CARD
        },
        // 3
        Card {
            list: 0,
            title: "ค้นหาและตัวกรอง",
            labels: &[1],
            body: r#"# การค้นหา
- กด **Ctrl+K** ที่ไหนก็ได้ (หรือคลิกช่องค้นหาด้านบน) เพื่อค้นหาทุกบอร์ดที่คุณเห็น จากชื่อ รายละเอียด หรือเลขการ์ด (`#12`) ภาษาไทยก็ค้นได้
- ในบอร์ด ช่อง **กรองการ์ด…** กรองสิ่งที่เห็นทันที ใช้ได้ทั้ง 3 มุมมอง
- **ตัวกรอง** กรองตามสถานะ ความสำคัญ และกำหนดส่ง ส่วน **ป้ายกำกับ** และ **งานของฉัน** ก็ตามชื่อเลย
- หน้าบอร์ดกรองตามชื่อและเจ้าของได้

- [ ] กด Ctrl+K แล้วค้นหาคำว่า "แกนต์"
"#,
            ..CARD
        },
        // 4
        Card {
            title: "สถานะ ความสำคัญ ป้ายกำกับ และวันที่",
            priority: 2,
            status: 1,
            labels: &[1],
            due_in_days: Some(1),
            body: r#"# รายละเอียดการ์ด
การ์ดนี้ตั้งค่าไว้เป็นตัวอย่าง: **2 ดาว** สถานะ **ติดปัญหา** ป้าย **เคล็ดลับ** และ **ครบกำหนดพรุ่งนี้**

- **สถานะ** คือจุดสี สถานะเป็นของแต่ละบอร์ด แก้ได้ที่ *ตั้งค่าบอร์ด → สถานะ* ติ๊ก **เสร็จ** ให้สถานะที่หมายถึงงานเสร็จ แถบบาง ๆ ใต้หัวคอลัมน์แสดงสัดส่วนสถานะ
- **ความสำคัญ** มี 0–3 ดาว
- **ป้ายกำกับ** เป็นของบอร์ด สีของป้ายแสดงเป็นแถบด้านบนการ์ด
- **วันเริ่ม** และ **กำหนดส่ง**: การ์ดที่เลยกำหนดจะเป็นสีแดง ส่วนการ์ดที่เสร็จแล้วจะไม่นับว่าเลยกำหนด
- **ผู้รับผิดชอบ**: ใครก็ได้ที่เป็นสมาชิกบอร์ด

- [ ] เปลี่ยนสถานะการ์ดนี้เป็น *พร้อม*
"#,
            ..CARD
        },
        // 5
        Card {
            title: "มุมมองบอร์ด ปฏิทิน และแกนต์",
            start_in_days: Some(-1),
            due_in_days: Some(3),
            body: r#"# ดูบอร์ดได้ 3 แบบ
สลับได้ที่ **บอร์ด · ปฏิทิน · แกนต์** มุมขวาบน ตัวกรองใช้ได้ทั้งสามแบบ

## ปฏิทิน
- **ลาก** การ์ดไปวันอื่นเพื่อเลื่อนกำหนด (เวลาเดิมคงไว้) หรือลากไปที่ **ไม่มีกำหนดส่ง** เพื่อลบวันที่
- สร้างการ์ดด้วยปุ่ม **การ์ดใหม่** **ดับเบิลคลิก** ที่วัน หรือคลิกขวาที่วัน
- **ปฏิทิน** บนแถบด้านบนแสดงการ์ดจาก *ทุกบอร์ด* ของคุณพร้อมกัน

## แกนต์
- การ์ดที่มีวันที่จะเป็นแถบตั้งแต่วันเริ่มถึงกำหนดส่ง การ์ดนี้และการ์ดถัดไปเป็นตัวอย่าง
- **ลากแถบ** เพื่อย้าย **ลากขอบ** เพื่อเปลี่ยนวัน และลาก **จุดที่ปลายแถบ** ไปยังการ์ดอื่นเพื่อให้การ์ดนั้นต้องรอการ์ดนี้
- สลับ **วัน / สัปดาห์ / เดือน** แสดง **ผู้รับผิดชอบ** และ **ป้ายกำกับ** กระโดดไปด้วย **วันนี้** และ **ไปยังวันที่** หรือลากหัววันที่เพื่อเลื่อนดูช่วงเวลา

- [ ] เปิดมุมมองแกนต์แล้วยืดแถบของการ์ดนี้ออกไปหนึ่งวัน
"#,
            ..CARD
        },
        // 6
        Card {
            title: "การ์ดที่ต้องรอ: การ์ดนี้รออีกใบ",
            start_in_days: Some(4),
            due_in_days: Some(6),
            waits_for: &[5],
            body: r#"# รอการ์ดอื่นก่อน
การ์ดนี้ **ต้องรอ** *"มุมมองบอร์ด ปฏิทิน และแกนต์"*: จะเริ่มได้จริงเมื่อการ์ดนั้นเสร็จแล้ว

- เปิดการ์ดแล้วใช้ **ต้องรอ → เพิ่ม** หรือลากเชื่อมในมุมมองแกนต์
- บนบอร์ด การ์ดที่ยังมีงานต้องรอค้างอยู่จะแสดงไอคอน 🔗 พร้อมจำนวน
- ในแกนต์ ลิงก์เป็นลูกศร และจะเป็น **สีแดง** เมื่อการ์ดถูกวางให้เริ่มก่อนการ์ดที่ต้องรอจะครบกำหนด

- [ ] ในมุมมองแกนต์ ลากแถบของการ์ดก่อนหน้าให้เลยวันเริ่มของการ์ดนี้ แล้วดูลูกศรเปลี่ยนเป็นสีแดง
"#,
            ..CARD
        },
        // 7
        Card {
            title: "ไฟล์แนบและการดูตัวอย่าง",
            body: r#"# ไฟล์
- ลากไฟล์มาวางบนการ์ดที่เปิดอยู่ หรือกด **อัปโหลดไฟล์**
- คลิกไฟล์เพื่อ **ดูตัวอย่าง** โดยไม่ต้องดาวน์โหลด: รูปภาพ PDF Word Excel/CSV PowerPoint ข้อความและโค้ด วิดีโอและเสียง ใช้ ← → เพื่อเปลี่ยนไฟล์
- ไฟล์เป็นส่วนตัว: เปิดได้เฉพาะคนที่เห็นบอร์ดนี้

- [ ] แนบไฟล์อะไรก็ได้ในการ์ดนี้แล้วลองเปิดดู
"#,
            ..CARD
        },
        // 8
        Card {
            title: "ความคิดเห็น การกล่าวถึง (@) และการอัปเดตสด",
            body: r#"# ทำงานร่วมกัน
- เขียนความคิดเห็นที่ท้ายการ์ด (ใช้ Markdown และวางรูปได้เช่นกัน) กด **Ctrl+Enter** เพื่อส่ง
- พิมพ์ **@** ตามด้วยชื่อเพื่อ **กล่าวถึง** คนนั้น เขาจะได้รับการแจ้งเตือน
- ทุกการเปลี่ยนแปลงบันทึกในไทม์ไลน์เดียวกัน: การย้าย สถานะ วันที่ ป้ายกำกับ ไฟล์แนบ และอื่น ๆ เอาติ๊ก **กิจกรรม** ออกเพื่อดูเฉพาะความคิดเห็น
- การเปลี่ยนแปลงของคนอื่นแสดง **ทันที** หัวบอร์ดแสดงว่ามีใครอยู่บ้าง (เขียว = กำลังดู, ส้ม = กำลังพิมพ์) และการ์ดที่มีคนเปิดอยู่จะแสดงรูปของเขา

- [ ] แสดงความคิดเห็นในการ์ดนี้
"#,
            ..CARD
        },
        // 9
        Card {
            title: "การแจ้งเตือน",
            labels: &[1],
            body: r#"# ไม่พลาดทุกเรื่อง
คุณจะได้รับแจ้งเมื่อถูก **มอบหมาย** การ์ด ถูก **กล่าวถึง (@)** เมื่อมีคน **แสดงความคิดเห็น** ในการ์ดของคุณ และเมื่อการ์ดของคุณ **จะครบกำหนดใน 24 ชั่วโมง** หรือ **เลยกำหนด**

- **กระดิ่ง** ด้านบนรวมทุกอย่างไว้
- **โปรไฟล์ → การแจ้งเตือน** เลือกช่องทางอื่นเพิ่มได้:
  - **อีเมล**
  - **การแจ้งเตือนบนเบราว์เซอร์** ของอุปกรณ์นี้ (โทรศัพท์ก็ได้) แม้ไม่ได้เปิด Kanb อยู่
  - **แอปแชต**: Discord, Slack, Microsoft Teams, Google Chat, Telegram, LINE, ntfy, Gotify หรือ webhook ใดก็ได้
- บอร์ดยังส่งความเคลื่อนไหวไปยัง **ช่องของทีม** ได้ด้วย: *ตั้งค่าบอร์ด → การแจ้งเตือน*

ช่องทางที่ใช้ได้ขึ้นกับการตั้งค่าของผู้ดูแลระบบ
"#,
            ..CARD
        },
        // 10
        Card {
            title: "เทมเพลตและการ์ดที่สร้างซ้ำ",
            body: r#"# ไม่ต้องพิมพ์ซ้ำ
- **เทมเพลตการ์ด**: บันทึกการ์ดใดก็ได้เป็นเทมเพลตจากเมนู (**บันทึกเป็นเทมเพลต**) แล้วใช้จากเมนู ⋯ ของคอลัมน์หรือหน้าต่าง **การ์ดใหม่** จัดการได้ที่ *ตั้งค่าบอร์ด → เทมเพลต*
- **การ์ดที่สร้างซ้ำ**: ที่ *ตั้งค่าบอร์ด → เทมเพลต → การ์ดที่สร้างซ้ำ* ให้ระบบสร้างการ์ดจากเทมเพลตทุกวัน ทุกสัปดาห์ หรือทุกเดือน เช่น รายงานทุกวันจันทร์ 09:00
- **เทมเพลตบอร์ด**: *ตั้งค่าบอร์ด → ทั่วไป → บันทึกเป็นเทมเพลตบอร์ด* เก็บคอลัมน์ สถานะ ป้ายกำกับ และเทมเพลตการ์ดไว้ เลือกใช้ได้ตอนสร้างบอร์ดใหม่ หน้า **เทมเพลต** บนแถบด้านบนรวมไว้ทั้งหมด
"#,
            ..CARD
        },
        // 11
        Card {
            title: "แอปปฏิทินของคุณ",
            due_in_days: Some(7),
            body: r#"# วันที่ใน Google, Apple หรือ Outlook Calendar
- **โปรไฟล์ → ลิงก์ปฏิทิน → สร้างลิงก์ปฏิทินของฉัน** แล้วนำลิงก์ไปสมัครในแอปปฏิทิน ข้อมูลจะอัปเดตเอง
- เลือกสิ่งที่แสดง: ทั้งแอป หรือ **เฉพาะที่เลือก** (บอร์ดที่ติ๊ก และการ์ดรายใบ)
- เพิ่มการ์ดรายใบด้วย **เพิ่มในปฏิทินของฉัน** ในการ์ดหรือเมนูของการ์ด การ์ดที่อยู่ในลิงก์จะมีไอคอนปฏิทินเล็ก ๆ
- เก็บลิงก์เป็นความลับ: ใครมีลิงก์จะเห็นชื่อและวันที่เหล่านั้น **ลิงก์ใหม่** จะแทนที่ลิงก์เดิม
"#,
            ..CARD
        },
        // 12
        Card {
            title: "ผู้ใช้ บทบาท และสิทธิ์",
            labels: &[1],
            body: r#"# ใครทำอะไรได้บ้าง
- ไม่มีการสมัครสมาชิกเอง **ผู้ดูแลสูงสุด** เป็นผู้สร้างบัญชี: รูปโปรไฟล์ (มุมขวาบน) → **ผู้ดูแลระบบ** → **ผู้ใช้** และตั้งค่าอีเมลและการแจ้งเตือนของทั้งระบบได้
- คนที่สร้างบอร์ดเป็น **เจ้าของ** บอร์ดนั้น
- ที่ **ตั้งค่าบอร์ด → สมาชิก** เพิ่มคนพร้อมบทบาท: *Owner, Admin, Editor, Commenter* หรือ *Viewer*
- **บทบาทและสิทธิ์** คือรายการสิทธิ์ของแต่ละบทบาท แบ่งเป็นหมวด ปรับได้ในแต่ละบอร์ด หรือสร้างบทบาทเองก็ได้
"#,
            ..CARD
        },
        // 13
        Card {
            title: "บัญชีของคุณ และการยืนยันตัวตนสองขั้นตอน",
            labels: &[1],
            body: r#"# โปรไฟล์
รูปโปรไฟล์ (มุมขวาบน) → **โปรไฟล์**:
- **บัญชี**: รูป ชื่อ อีเมล (ใช้รีเซ็ตรหัสผ่านและรับการแจ้งเตือน) และสี
- **ความปลอดภัย**: เปลี่ยนรหัสผ่าน และเปิด **การยืนยันตัวตนสองขั้นตอน** ด้วยแอปยืนยันตัวตน (Google Authenticator, Microsoft Authenticator, 1Password…) เก็บรหัสกู้คืนไว้ในที่ปลอดภัย
- **การแจ้งเตือน** และ **ลิงก์ปฏิทิน**: ดูการ์ดก่อนหน้า

ภาษาและธีมอยู่ในเมนูใต้รูปโปรไฟล์

- [ ] เปิดการยืนยันตัวตนสองขั้นตอน
"#,
            ..CARD
        },
        // 14
        Card {
            title: "เก็บ ส่งออก และลบ",
            labels: &[1],
            body: r#"# จัดระเบียบ
- **เก็บ** ซ่อนการ์ด คอลัมน์ หรือบอร์ด แต่ข้อมูลยังอยู่ครบ กู้คืนได้ทุกเมื่อ:
  - การ์ดที่เก็บไว้: **ตั้งค่าบอร์ด → ที่เก็บ**
  - บอร์ดที่เก็บไว้: **หน้าบอร์ด → ที่เก็บ**
- **ส่งออก** บอร์ดได้ที่ *ตั้งค่าบอร์ด → ทั่วไป*: สเปรดชีต (CSV) ข้อมูลทั้งหมด (JSON) หรือทุกอย่างรวมไฟล์แนบ (ZIP)
- **ลบถาวร** ลบออกจริง: ความคิดเห็น ประวัติ และ **ไฟล์แนบ รวมถึงไฟล์ที่จัดเก็บไว้** ย้อนกลับไม่ได้

เมื่อดูครบแล้ว จะเก็บหรือลบบอร์ดนี้ก็ได้ ขอบอร์ดใหม่ได้จากหน้าบอร์ด: คลิกขวาที่หน้าแล้วเลือก *เพิ่มบอร์ดแนะนำการใช้งาน*
"#,
            ..CARD
        },
        // 15
        Card {
            title: "บนโทรศัพท์หรือแท็บเล็ต",
            labels: &[1],
            body: r#"# Kanb พกไปได้ทุกที่
- **กดค้าง** ที่การ์ดแล้วค่อยลาก ส่วนการปัดปกติคือเลื่อนหน้าจอ
- ในการ์ดที่เปิดอยู่ ปุ่ม **⋯** ด้านบนมีทุกคำสั่งเหมือนเมนูคลิกขวา
- ปฏิทินแสดงจุดแทนการ์ด **แตะที่วัน** เพื่อดูรายการการ์ดของวันนั้น
- ในมุมมองแกนต์ ปัดเพื่อเลื่อน และแตะแถบเพื่อเปิดการ์ด
- **ติดตั้งเหมือนแอป**: ในเมนูของเบราว์เซอร์เลือก *เพิ่มไปยังหน้าจอโฮม* หรือ *ติดตั้งแอป* บน iPhone หรือ iPad วิธีนี้ยังทำให้ Kanb ส่งการแจ้งเตือนได้ด้วย
"#,
            ..CARD
        },
        // 16
        Card {
            list: 2,
            title: "คีย์ลัด",
            status: 3,
            labels: &[1],
            body: r#"| ปุ่ม | ใช้ทำอะไร |
|---|---|
| Ctrl+K | ค้นหาทั้งหมด (ในช่องเขียน: ใส่ลิงก์) |
| Enter | เปิดการ์ดที่เลือกอยู่ |
| Ctrl+Enter | ส่งความคิดเห็น / บันทึก |
| Ctrl+B / I / E | ตัวหนา / ตัวเอียง / โค้ด |
| Esc | ปิดหน้าต่าง |
| ← → | ไฟล์ก่อนหน้า / ถัดไป ในหน้าดูตัวอย่าง |

การ์ดนี้มีสถานะ *เสร็จแล้ว* จึงถูกนับในแถบความคืบหน้าข้างชื่อบอร์ด
"#,
            ..CARD
        },
    ],
};

/// Creates a fresh tutorial board owned by `user_id`, in `locale` ("th" or anything else = English).
pub async fn create(db: &PgPool, user_id: Uuid, locale: &str) -> AppResult<Board> {
    let c = if locale == "th" { &TH } else { &EN };
    let mut tx = db.begin().await?;
    let lists: Vec<String> = c.lists.iter().map(|s| s.to_string()).collect();
    // created_by NULL marks it as created by the system
    let (board, list_ids, status_ids) =
        crate::boards::insert_board(&mut tx, None, user_id, locale, c.name, c.description, Some("#14b8a6"), &lists).await?;
    let mut label_ids = Vec::new();
    for (name, color) in c.labels {
        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO labels (id, board_id, name, color) VALUES ($1,$2,$3,$4)")
            .bind(id)
            .bind(board.id)
            .bind(name)
            .bind(color)
            .execute(&mut *tx)
            .await?;
        label_ids.push(id);
    }
    let mut last_pos: Vec<Option<String>> = vec![None; list_ids.len()];
    let mut card_ids = Vec::with_capacity(c.cards.len());
    // dates relative to today: starts at 09:00 and due at 17:00 UTC+7 (02:00 / 10:00 UTC)
    let day = |d: i64, hour: u32| (Utc::now() + Duration::days(d)).date_naive().and_hms_opt(hour, 0, 0).unwrap().and_utc();
    for (n, card) in c.cards.iter().enumerate() {
        let pos = position::between(last_pos[card.list].as_deref(), None);
        let id = Uuid::now_v7();
        // the last default status ("Done") counts as finished: record when, as a real move there would
        let done = card.status == 3;
        sqlx::query(
            "INSERT INTO cards (id, board_id, list_id, number, title, description, position, priority, status_id, start_at, due_at, done_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $12 THEN now() END)",
        )
        .bind(id)
        .bind(board.id)
        .bind(list_ids[card.list])
        .bind(n as i32 + 1)
        .bind(card.title)
        .bind(card.body)
        .bind(&pos)
        .bind(card.priority)
        .bind(status_ids.get(card.status).copied())
        .bind(card.start_in_days.map(|d| day(d, 2)))
        .bind(card.due_in_days.map(|d| day(d, 10)))
        .bind(done)
        .execute(&mut *tx)
        .await?;
        for &before in card.waits_for {
            sqlx::query("INSERT INTO card_dependencies (card_id, depends_on, created_by) VALUES ($1, $2, NULL)")
                .bind(id)
                .bind(card_ids[before])
                .execute(&mut *tx)
                .await?;
        }
        card_ids.push(id);
        for &l in card.labels {
            sqlx::query("INSERT INTO card_labels (card_id, label_id) VALUES ($1,$2)").bind(id).bind(label_ids[l]).execute(&mut *tx).await?;
        }
        last_pos[card.list] = Some(pos);
    }
    sqlx::query("UPDATE boards SET card_seq = $2, is_tutorial = true WHERE id = $1")
        .bind(board.id)
        .bind(c.cards.len() as i32)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(board)
}

/// POST /api/me/tutorial — a fresh copy for the current user, in their language.
pub async fn create_for_me(State(state): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Board>> {
    Ok(Json(create(&state.db, u.id, &u.locale).await?))
}
