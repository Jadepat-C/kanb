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
    status: usize,
    labels: &'static [usize],
    due_in_days: Option<i64>,
}

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
        Card {
            list: 0,
            title: "Welcome! Open me first",
            priority: 0,
            status: 0,
            labels: &[0],
            due_in_days: None,
            body: r#"# Welcome 👋

This board is **your own copy** of the tutorial. Nothing you do here affects anyone else, so click, drag and edit freely.

## How it's organised
- **Boards** hold **columns**, and columns hold **cards**.
- Each card has a description (Markdown), status, priority, labels, assignees, a due date, attachments, comments and an activity log.
- Open any card by clicking it. Hover over a card for a quick preview.

## Try this
- [ ] Open the next card: *"Cards are Markdown"*
- [ ] Switch language (EN / ไทย) and theme (☀️ / 🌙) in the top bar
- [ ] Drag this card to **Done** when you've read it
"#,
        },
        Card {
            list: 0,
            title: "Cards are Markdown",
            priority: 1,
            status: 0,
            labels: &[0],
            due_in_days: None,
            body: r#"# Writing in cards

The description works like **Obsidian**: Markdown renders as you type, and the raw syntax only shows on the line you're editing. Click anywhere in this text to see it.

## Formatting
**Bold**, *italic*, ~~strikethrough~~, `inline code` and [links](https://www.markdownguide.org/basic-syntax/) (Ctrl+click to open).

> Quotes look like this.

```sql
SELECT * FROM tasks WHERE done = false;
```

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
        },
        Card {
            list: 0,
            title: "Drag & drop, and right-click",
            priority: 0,
            status: 0,
            labels: &[0],
            due_in_days: None,
            body: r#"# Moving things around
- **Drag a card** to another column or up/down within a column.
- **Drag a column** by its header (the ⠿ grip) to reorder columns.
- **Sort a column** from its ⋯ menu: by priority, due date, newest, title…

# Right-click everything
- **Right-click a card**: open, rename, duplicate, move, change status, priority, due date, labels, colour, archive or delete.
- **Right-click a column**: new card, fold, sort, rename, WIP limit.
- **Right-click a board** on the Boards page: open, rename, colour, archive, delete.
- **Right-click a day** in the calendar: create a card on that day.

- [ ] Right-click this card and give it a colour
"#,
        },
        Card {
            list: 0,
            title: "Search and filters",
            priority: 0,
            status: 0,
            labels: &[1],
            due_in_days: None,
            body: r#"# Finding things
- Press **Ctrl+K** anywhere to search every board you can see, by title, description or card number (`#12`). Thai works too.
- On a board, the **Filter cards…** box filters what you see instantly.
- **Filters** narrows by status, priority and due date; **Labels** and **Assigned to me** do what they say.
- The Boards page can be filtered by name and by owner.

- [ ] Press Ctrl+K and search for "calendar"
"#,
        },
        Card {
            list: 1,
            title: "Status, priority, labels, due date",
            priority: 2,
            status: 1,
            labels: &[1],
            due_in_days: Some(1),
            body: r#"# Card properties
This card is set up as an example: **2 stars**, status **Blocked**, the **Tip** label and a **due date tomorrow**.

- **Status** is the coloured dot. Statuses are per board and fully customisable (*Board settings → Statuses*). The thin bar under each column header shows the mix of statuses.
- **Priority** is 0–3 stars.
- **Labels** are per board; create them from a card or in Board settings.
- **Due date**: overdue cards turn red.
- **Assignees**: anyone who's a member of the board.

- [ ] Change this card's status to *Ready*
"#,
        },
        Card {
            list: 1,
            title: "Calendar view",
            priority: 0,
            status: 0,
            labels: &[0],
            due_in_days: Some(3),
            body: r#"# Calendar
- On a board, switch **Board ↔ Calendar** (top right). The calendar uses the same filters as the board.
- **Calendar** in the top bar shows cards from *all* your boards, each labelled with its board.
- **Drag** a card to another day to reschedule it (the time is kept). Drag it to **No due date** to clear the date.
- **Create** a card with **New card**, by **double-clicking** a day, or by **right-clicking** a day.

- [ ] Find this card in the calendar (it's due in 3 days) and drag it to another day
"#,
        },
        Card {
            list: 1,
            title: "Attachments and previews",
            priority: 0,
            status: 0,
            labels: &[0],
            due_in_days: None,
            body: r#"# Files
- Drop files onto an open card, or use **Upload file**.
- Click an attachment to **preview** it without downloading: images, PDF, Word, Excel/CSV, PowerPoint, text and code, video and audio. Use ← → to flip through them.
- Files are private: they're only served to people who can see the board.

- [ ] Attach any file to this card and preview it
"#,
        },
        Card {
            list: 1,
            title: "Comments and activity",
            priority: 0,
            status: 0,
            labels: &[0],
            due_in_days: None,
            body: r#"# Talking about work
- Write a comment at the bottom of a card (Markdown and pasted images work here too). **Ctrl+Enter** posts it.
- Every change is logged in the same timeline: moves, status, due dates, labels, attachments and more. A burst of description edits is folded into one entry.
- Untick **Activity** to see only comments.

- [ ] Leave a comment on this card
"#,
        },
        Card {
            list: 1,
            title: "Members, roles and permissions",
            priority: 0,
            status: 0,
            labels: &[1],
            due_in_days: None,
            body: r#"# Who can do what
- There's no public sign-up. A **super admin** creates accounts (top bar → **Users**) and can see every board.
- Whoever creates a board is its **Owner**.
- In **Board settings → Members** you add people with a role: *Owner, Admin, Editor, Commenter* or *Viewer*.
- **Roles & permissions** is a matrix you can change per board, and you can create your own roles.
"#,
        },
        Card {
            list: 1,
            title: "Archive vs. delete",
            priority: 0,
            status: 0,
            labels: &[1],
            due_in_days: None,
            body: r#"# Cleaning up
- **Archive** hides a card or board but keeps everything. Restore it any time:
  - archived cards: **Board settings → Archive**
  - archived boards: **Boards page → Archived**
- **Delete permanently** removes it for good: comments, history and **attachments, including the stored files**. This can't be undone.

When you've finished the tour, archive or delete this board. You can get a fresh copy from the Boards page (right-click → *Add tutorial board*, or the button when you have no boards).
"#,
        },
        Card {
            list: 2,
            title: "Keyboard shortcuts",
            priority: 0,
            status: 2,
            labels: &[1],
            due_in_days: None,
            body: r#"| Keys | What it does |
|---|---|
| Ctrl+K | Search everything (in the editor: insert a link) |
| Enter | Open the focused card |
| Ctrl+Enter | Post a comment / save |
| Ctrl+B / I / E | Bold / italic / code |
| Esc | Close dialogs |
| ← → | Previous / next file in the preview |
"#,
        },
    ],
};

const TH: Content = Content {
    name: "👋 เริ่มต้นใช้งาน",
    description: "บอร์ดแนะนำการใช้งานที่ระบบสร้างให้คุณ ลองเล่นได้ตามสบาย เสร็จแล้วจะเก็บหรือลบทิ้งก็ได้",
    lists: ["เริ่มที่นี่", "เรียนรู้เพิ่มเติม", "เสร็จแล้ว"],
    labels: [("บทเรียน", "#2f5bd3"), ("เคล็ดลับ", "#22c55e")],
    cards: &[
        Card {
            list: 0,
            title: "ยินดีต้อนรับ! เปิดการ์ดนี้ก่อน",
            priority: 0,
            status: 0,
            labels: &[0],
            due_in_days: None,
            body: r#"# ยินดีต้อนรับ 👋

บอร์ดนี้เป็น **สำเนาส่วนตัวของคุณ** สิ่งที่ทำในนี้ไม่กระทบคนอื่น คลิก ลาก หรือแก้ไขได้เต็มที่

## โครงสร้าง
- **บอร์ด** มี **คอลัมน์** และในคอลัมน์มี **การ์ด**
- การ์ดแต่ละใบมีรายละเอียด (Markdown) สถานะ ความสำคัญ ป้ายกำกับ ผู้รับผิดชอบ กำหนดส่ง ไฟล์แนบ ความคิดเห็น และประวัติการเปลี่ยนแปลง
- คลิกการ์ดเพื่อเปิด หรือวางเมาส์ค้างไว้เพื่อดูตัวอย่างแบบย่อ

## ลองทำ
- [ ] เปิดการ์ดถัดไป *"การ์ดเขียนด้วย Markdown"*
- [ ] สลับภาษา (EN / ไทย) และธีม (☀️ / 🌙) ที่แถบด้านบน
- [ ] อ่านจบแล้ว ลากการ์ดนี้ไปที่ **เสร็จแล้ว**
"#,
        },
        Card {
            list: 0,
            title: "การ์ดเขียนด้วย Markdown",
            priority: 1,
            status: 0,
            labels: &[0],
            due_in_days: None,
            body: r#"# การเขียนในการ์ด

ช่องรายละเอียดทำงานแบบ **Obsidian**: Markdown แสดงผลทันทีขณะพิมพ์ และจะเห็นสัญลักษณ์เฉพาะบรรทัดที่กำลังแก้ไข ลองคลิกที่ข้อความนี้ดู

## การจัดรูปแบบ
**ตัวหนา**, *ตัวเอียง*, ~~ขีดฆ่า~~, `โค้ด` และ [ลิงก์](https://www.markdownguide.org/basic-syntax/) (Ctrl+คลิก เพื่อเปิด)

> ข้อความอ้างอิงหน้าตาแบบนี้

```sql
SELECT * FROM tasks WHERE done = false;
```

## เช็กลิสต์
ติ๊กได้เลย บนบอร์ดจะแสดงความคืบหน้า (เช่น 1/3)
- [ ] ติ๊กฉัน
- [ ] ติ๊กฉันด้วย
- [ ] ขึ้นบรรทัดใหม่แล้วพิมพ์ `- [ ] ` เพื่อเพิ่มรายการ

## ควรรู้
- ใช้ **แถบเครื่องมือ** เหนือช่องเขียน หรือปุ่มลัด Ctrl+B, Ctrl+I, Ctrl+E (โค้ด), Ctrl+K (ลิงก์)
- **วางภาพหน้าจอ** (Ctrl+V) หรือลากรูปมาวาง ระบบจะอัปโหลดและแสดงในข้อความ
- **บันทึกอัตโนมัติ** หลังหยุดพิมพ์ครู่หนึ่ง
"#,
        },
        Card {
            list: 0,
            title: "ลากวาง และคลิกขวา",
            priority: 0,
            status: 0,
            labels: &[0],
            due_in_days: None,
            body: r#"# การย้าย
- **ลากการ์ด** ไปคอลัมน์อื่น หรือเลื่อนขึ้นลงในคอลัมน์เดิม
- **ลากคอลัมน์** ที่หัวคอลัมน์ (ไอคอน ⠿) เพื่อสลับลำดับ
- **เรียงการ์ด** จากเมนู ⋯ ของคอลัมน์: ตามความสำคัญ กำหนดส่ง ใหม่สุด ชื่อ…

# คลิกขวาได้แทบทุกที่
- **คลิกขวาที่การ์ด**: เปิด เปลี่ยนชื่อ ทำสำเนา ย้าย เปลี่ยนสถานะ ความสำคัญ กำหนดส่ง ป้ายกำกับ สี เก็บ หรือลบ
- **คลิกขวาที่คอลัมน์**: การ์ดใหม่ ย่อ เรียง เปลี่ยนชื่อ จำกัดจำนวนงาน
- **คลิกขวาที่บอร์ด** ในหน้าบอร์ด: เปิด เปลี่ยนชื่อ สี เก็บ ลบ
- **คลิกขวาที่วัน** ในปฏิทิน: สร้างการ์ดในวันนั้น

- [ ] คลิกขวาที่การ์ดนี้แล้วเปลี่ยนสี
"#,
        },
        Card {
            list: 0,
            title: "ค้นหาและตัวกรอง",
            priority: 0,
            status: 0,
            labels: &[1],
            due_in_days: None,
            body: r#"# การค้นหา
- กด **Ctrl+K** ที่ไหนก็ได้ เพื่อค้นหาทุกบอร์ดที่คุณเห็น จากชื่อ รายละเอียด หรือหมายเลขการ์ด (`#12`) รองรับภาษาไทย
- ในบอร์ด ช่อง **กรองการ์ด…** กรองทันทีที่พิมพ์
- ปุ่ม **ตัวกรอง** กรองตามสถานะ ความสำคัญ และกำหนดส่ง ส่วน **ป้ายกำกับ** และ **งานของฉัน** ก็ตามชื่อ
- หน้าบอร์ดกรองได้ทั้งชื่อและเจ้าของ

- [ ] กด Ctrl+K แล้วค้นคำว่า "ปฏิทิน"
"#,
        },
        Card {
            list: 1,
            title: "สถานะ ความสำคัญ ป้ายกำกับ กำหนดส่ง",
            priority: 2,
            status: 1,
            labels: &[1],
            due_in_days: Some(1),
            body: r#"# คุณสมบัติของการ์ด
การ์ดนี้ตั้งค่าไว้เป็นตัวอย่าง: **2 ดาว**, สถานะ **ติดปัญหา**, ป้าย **เคล็ดลับ** และ **กำหนดส่งพรุ่งนี้**

- **สถานะ** คือจุดสีบนการ์ด แต่ละบอร์ดกำหนดเองได้ (*ตั้งค่าบอร์ด → สถานะ*) แถบบาง ๆ ใต้หัวคอลัมน์แสดงสัดส่วนสถานะ
- **ความสำคัญ** 0–3 ดาว
- **ป้ายกำกับ** แยกตามบอร์ด สร้างได้จากการ์ดหรือในตั้งค่าบอร์ด
- **กำหนดส่ง** การ์ดที่เลยกำหนดจะเป็นสีแดง
- **ผู้รับผิดชอบ** เลือกได้จากสมาชิกของบอร์ด

- [ ] เปลี่ยนสถานะการ์ดนี้เป็น *พร้อม*
"#,
        },
        Card {
            list: 1,
            title: "มุมมองปฏิทิน",
            priority: 0,
            status: 0,
            labels: &[0],
            due_in_days: Some(3),
            body: r#"# ปฏิทิน
- ในบอร์ด สลับ **บอร์ด ↔ ปฏิทิน** (มุมขวาบน) ปฏิทินใช้ตัวกรองเดียวกับบอร์ด
- **ปฏิทิน** ที่แถบด้านบนรวมการ์ดจาก *ทุกบอร์ด* พร้อมบอกว่ามาจากบอร์ดไหน
- **ลาก** การ์ดไปวันอื่นเพื่อเลื่อนกำหนด (เวลาเดิมยังอยู่) ลากไปที่ **ไม่มีกำหนดส่ง** เพื่อลบวันที่
- **สร้าง** การ์ดด้วยปุ่ม **การ์ดใหม่**, **ดับเบิลคลิก** ที่วัน หรือ **คลิกขวา** ที่วัน

- [ ] หาการ์ดนี้ในปฏิทิน (ครบกำหนดอีก 3 วัน) แล้วลากไปวันอื่น
"#,
        },
        Card {
            list: 1,
            title: "ไฟล์แนบและการดูตัวอย่าง",
            priority: 0,
            status: 0,
            labels: &[0],
            due_in_days: None,
            body: r#"# ไฟล์
- ลากไฟล์มาวางบนการ์ดที่เปิดอยู่ หรือกด **อัปโหลดไฟล์**
- คลิกไฟล์แนบเพื่อ **ดูตัวอย่าง** โดยไม่ต้องดาวน์โหลด: รูป, PDF, Word, Excel/CSV, PowerPoint, ข้อความและโค้ด, วิดีโอและเสียง กด ← → เพื่อเลื่อนไฟล์
- ไฟล์เป็นส่วนตัว เปิดได้เฉพาะคนที่เห็นบอร์ดนี้

- [ ] แนบไฟล์อะไรก็ได้แล้วลองดูตัวอย่าง
"#,
        },
        Card {
            list: 1,
            title: "ความคิดเห็นและกิจกรรม",
            priority: 0,
            status: 0,
            labels: &[0],
            due_in_days: None,
            body: r#"# พูดคุยเรื่องงาน
- เขียนความคิดเห็นที่ด้านล่างของการ์ด (ใช้ Markdown และวางรูปได้) กด **Ctrl+Enter** เพื่อส่ง
- ทุกการเปลี่ยนแปลงถูกบันทึกในไทม์ไลน์เดียวกัน: ย้าย สถานะ กำหนดส่ง ป้าย ไฟล์ ฯลฯ การแก้รายละเอียดติดกันหลายครั้งจะรวมเป็นรายการเดียว
- เอาเครื่องหมายออกจาก **กิจกรรม** เพื่อดูเฉพาะความคิดเห็น

- [ ] ลองแสดงความคิดเห็นในการ์ดนี้
"#,
        },
        Card {
            list: 1,
            title: "สมาชิก บทบาท และสิทธิ์",
            priority: 0,
            status: 0,
            labels: &[1],
            due_in_days: None,
            body: r#"# ใครทำอะไรได้บ้าง
- ไม่มีการสมัครสมาชิกเอง **ผู้ดูแลสูงสุด** เป็นผู้สร้างบัญชี (แถบด้านบน → **ผู้ใช้**) และเห็นทุกบอร์ด
- ผู้สร้างบอร์ดเป็น **เจ้าของ** บอร์ดนั้น
- ใน **ตั้งค่าบอร์ด → สมาชิก** เพิ่มคนพร้อมบทบาท: *Owner, Admin, Editor, Commenter* หรือ *Viewer*
- **บทบาทและสิทธิ์** เป็นตารางที่ปรับได้ในแต่ละบอร์ด และสร้างบทบาทใหม่เองได้
"#,
        },
        Card {
            list: 1,
            title: "เก็บ กับ ลบถาวร ต่างกันอย่างไร",
            priority: 0,
            status: 0,
            labels: &[1],
            due_in_days: None,
            body: r#"# การจัดเก็บ
- **เก็บ (Archive)** ซ่อนการ์ดหรือบอร์ดโดยข้อมูลยังอยู่ครบ กู้คืนได้ทุกเมื่อ:
  - การ์ดที่เก็บ: **ตั้งค่าบอร์ด → ที่เก็บ**
  - บอร์ดที่เก็บ: **หน้าบอร์ด → ที่เก็บ**
- **ลบถาวร** ลบทิ้งจริง ทั้งความคิดเห็น ประวัติ และ **ไฟล์แนบรวมถึงไฟล์ในที่เก็บข้อมูล** ย้อนกลับไม่ได้

ดูจบแล้วจะเก็บหรือลบบอร์ดนี้ก็ได้ ขอบอร์ดใหม่ได้จากหน้าบอร์ด (คลิกขวา → *เพิ่มบอร์ดแนะนำการใช้งาน* หรือปุ่มที่แสดงเมื่อยังไม่มีบอร์ด)
"#,
        },
        Card {
            list: 2,
            title: "ปุ่มลัดคีย์บอร์ด",
            priority: 0,
            status: 2,
            labels: &[1],
            due_in_days: None,
            body: r#"| ปุ่ม | ใช้ทำอะไร |
|---|---|
| Ctrl+K | ค้นหาทั้งหมด (ในช่องเขียน: ใส่ลิงก์) |
| Enter | เปิดการ์ดที่เลือกอยู่ |
| Ctrl+Enter | ส่งความคิดเห็น / บันทึก |
| Ctrl+B / I / E | ตัวหนา / ตัวเอียง / โค้ด |
| Esc | ปิดหน้าต่าง |
| ← → | ไฟล์ก่อนหน้า / ถัดไป ในหน้าดูตัวอย่าง |
"#,
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
    for (n, card) in c.cards.iter().enumerate() {
        let pos = position::between(last_pos[card.list].as_deref(), None);
        let id = Uuid::now_v7();
        // due dates at 17:00 Bangkok time (10:00 UTC)
        let due = card.due_in_days.map(|d| (Utc::now() + Duration::days(d)).date_naive().and_hms_opt(10, 0, 0).unwrap().and_utc());
        sqlx::query(
            "INSERT INTO cards (id, board_id, list_id, number, title, description, position, priority, status_id, due_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
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
        .bind(due)
        .execute(&mut *tx)
        .await?;
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
