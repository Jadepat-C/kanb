import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

const en = {
  app: { name: 'Kanban' },
  common: {
    save: 'Save', cancel: 'Cancel', delete: 'Delete', edit: 'Edit', close: 'Close', add: 'Add', create: 'Create',
    loading: 'Loading…', search: 'Search', name: 'Name', description: 'Description', color: 'Color', none: 'None',
    confirmDelete: 'Delete this? This cannot be undone.', yes: 'Yes', no: 'No', saved: 'Saved', rename: 'Rename',
    back: 'Back', clear: 'Clear', remove: 'Remove', done: 'Done', settings: 'Settings',
  },
  auth: {
    signIn: 'Sign in', signOut: 'Sign out', username: 'Username', usernameOrEmail: 'Username or email', forgot: 'Forgot password?', forgotTitle: 'Forgot password', forgotHint: 'Enter your username or email. If the account has an email address, we’ll send a link to choose a new password.', sendLink: 'Send link', forgotSent: 'If that account has an email address, a link is on its way. It is valid for 1 hour.', backToSignIn: 'Back to sign in', confirmPassword: 'Repeat new password', passwordsDiffer: 'The passwords don’t match.', savePassword: 'Save password', chooseNewPassword: 'Choose a new password', forcedHint: 'Hi {{name}}, your password was set by an administrator. Please choose your own to continue.', welcomeSetPassword: 'Welcome! Set your password', forAccount: 'Account: {{username}}', linkInvalidTitle: 'Link expired', linkInvalid: 'This link has expired or was already used.', requestNewLink: 'Request a new link', passwordSet: 'Password saved. You can sign in now.', password: 'Password',
    welcome: 'Sign in to your workspace', noSignup: 'Accounts are created by an administrator.',
  },
  nav: { boards: 'Boards', calendar: 'Calendar', admin: 'Admin', profile: 'Profile', language: 'Language', theme: 'Theme' },
  theme: { light: 'Light', dark: 'Dark', system: 'System' },
  search: {
    placeholder: 'Search boards and cards…', hint: 'Search everything', noResults: 'No results', boards: 'Boards', cards: 'Cards',
    filterCards: 'Filter cards…', filterBoards: 'Filter boards…',
  },
  boards: {
    title: 'Boards', new: 'New board', empty: 'No boards yet.', cards_one: '{{count}} card', cards_other: '{{count}} cards',
    members_one: '{{count}} member', members_other: '{{count}} members', notMember: 'Not a member (super admin view)', tab_active: 'Active', tab_archived: 'Archived', addTutorial: 'Add tutorial board', dragHint: 'Drag boards to arrange them (only your own view changes).', dragDisabled: 'Clear the filters to rearrange boards.', showArchived: 'Show archived boards', showActive: 'Show active boards', openNewTab: 'Open in new tab', leaveMsg: 'Leave “{{name}}”? You will lose access unless someone adds you again.',
    namePlaceholder: 'Board name', defaultLists: 'To Do, In Progress, Done', listsLabel: 'Columns (comma separated)',
  },
  board: {
    addList: 'Add column', listName: 'Column name', addCard: 'Add card', cardTitle: 'Card title…', fold: 'Fold', unfold: 'Unfold',
    wipLimit: 'WIP limit', wipPrompt: 'Max cards in this column (empty = no limit)', deleteList: 'Delete column',
    settings: 'Board settings', onlyMine: 'Assigned to me', labels: 'Labels', filters: 'Filters', clearFilters: 'Clear filters',
    readOnly: 'Read only', overdue: 'Overdue', live: 'Live updates on', offline: 'Reconnecting…',
  },
  card: {
    description: 'Description', noDescription: 'No description. Click to add one.', write: 'Write', preview: 'Preview',
    attachments: 'Attachments', upload: 'Upload file', dropHere: 'Drop files to attach', activity: 'Activity',
    comment: 'Comment', commentPlaceholder: 'Write a comment… (Markdown, paste images)', post: 'Post',
    column: 'Column', assignees: 'Assignees', labels: 'Labels', priority: 'Priority', status: 'Status', due: 'Due date',
    color: 'Color', archive: 'Archive card', archiveConfirm: 'Archive this card? You can restore it from Board settings → Archive.', deleteAttachmentMsg: 'Delete the attachment “{{name}}”? The file is removed from storage.', deleteCommentMsg: 'Delete this comment?', checklist: 'Checklist',
    created: 'Created', updated: 'Updated', uploading: 'Uploading {{name}}… {{pct}}%', edited: 'edited',
    markdownHint: 'Markdown supported · paste or drop images', editDescription: 'Edit description',
    status_normal: 'In progress', status_blocked: 'Blocked', status_ready: 'Ready',
  },
  event: {
    created: 'created this card in {{list}}', title: 'renamed the card from “{{from}}” to “{{to}}”',
    description: 'updated the description', priority: 'changed priority from {{from}} to {{to}}',
    status: 'changed status from {{from}} to {{to}}', noStatus: 'none', color: 'changed the color', due: 'changed the due date to {{to}}',
    dueCleared: 'removed the due date', moved: 'moved this card from {{from}} to {{to}}', archived: 'archived this card', restored: 'restored this card',
    labels: 'changed labels', assignees: 'changed assignees', added: 'added {{items}}', removed: 'removed {{items}}',
    attachment_added: 'attached {{filename}}', duplicated: 'created this card as a copy of #{{from}}', attachment_removed: 'removed attachment {{filename}}',
  },
  settings: {
    title: 'Board settings', general: 'General', members: 'Members', roles: 'Roles & permissions', labels: 'Labels', archive: 'Archive', statuses: 'Statuses', newStatus: 'New status', statusHint: 'Shown as a colored dot on cards and in the column progress bar. New cards get the first status.',
    addMember: 'Add member', removeMemberMsg: 'Remove {{name}} from this board?', deleteRoleMsg: 'Delete the role “{{name}}”?', deleteLabelMsg: 'Delete the label “{{name}}”? It is removed from all cards.', deleteStatusMsg: 'Delete the status “{{name}}”? Cards using it will have no status.', role: 'Role', newRole: 'New role', owner: 'Owner (all permissions)', deleteBoard: 'Delete board',
    deleteBoardConfirm: 'Delete this board for everyone?', leave: 'Leave board', newLabel: 'New label',
  },
  perm: {
    'board.manage': 'Edit board settings', 'board.delete': 'Delete board', 'members.manage': 'Manage members & roles',
    'lists.manage': 'Manage columns', 'labels.manage': 'Manage labels', 'cards.create': 'Create cards', 'cards.edit': 'Edit cards',
    'cards.move': 'Move cards', 'cards.delete': 'Archive cards', 'comments.create': 'Comment',
    'comments.moderate': 'Delete others’ comments', 'attachments.upload': 'Upload attachments',
    'attachments.delete': 'Delete any attachment',
  },
  admin: {
    title: 'Users', newUser: 'New user', displayName: 'Display name', email: 'Email', superAdmin: 'Super admin', search: 'Search name, username or email…', count_one: '{{count}} user', count_other: '{{count}} users', mustChange: 'must change password', deleteUser: 'Delete user', generate: 'Generate', copy: 'Copy', showPassword: 'Show password', passwordHint: 'At least 8 characters. They must change it at first sign-in.', sendInvite: 'Email a sign-in link', sendInviteHint: 'They get a link to set their own password (valid 3 days).', emailNotSetUp: 'Set up email (Email settings tab) and enter an address to enable this.', userCreated: 'Created {{name}}', inviteSent: 'Sign-in link sent to {{email}}.', inviteFailed: 'Email could not be sent', handOver: 'Sign-in details to hand over (the password is shown only now):', mustChangeHint: 'They will have to choose their own password when they sign in.', copyDetails: 'Copy details', signInAt: 'Sign in at', passwordCopied: 'New password copied to the clipboard', passwordReset: 'Password reset for {{name}}', resetLinkSent: 'Reset link sent to {{email}}', emailLinkHint: 'Recommended: email a reset link to {{email}} so only they know the new password.', emailResetLink: 'Email reset link', setPassword: 'Set this password', userDeleted: 'Deleted {{name}}', delBoardsDeleted_one: 'This board is deleted (only they are in it):', delBoardsDeleted_other: 'These {{count}} boards are deleted (only they are in them):', delNewOwner_one: 'This shared board gets a new owner (its longest-standing member):', delNewOwner_other: 'These {{count}} shared boards get a new owner (their longest-standing member):', delRemovedFrom_one: 'They are removed from 1 other shared board.', delRemovedFrom_other: 'They are removed from {{count}} other shared boards.', delHistory: 'Their comments and activity stay, shown as “{{label}}”. Their username and email can be used again.', emailHint: 'Can be used to sign in. Leave empty to remove.',
    canCreateBoards: 'Can create boards', active: 'Active', inactive: 'Disabled', resetPassword: 'Reset password',
    newPassword: 'New password', languageHint: 'Also the language of their “Getting started” board.', disable: 'Disable', enable: 'Enable', you: 'you',
  },
  profile: {
    title: 'Profile', changePassword: 'Change password', currentPassword: 'Current password', newPassword: 'New password',
    passwordChanged: 'Password changed. Other sessions were signed out.', uploadPicture: 'Upload picture', changePicture: 'Change picture', pictureHint: 'PNG, JPEG, WebP or GIF, up to 10 MB. Cropped to a square; photo location data is removed. Without a picture, your initials and colour are shown.', pictureSaved: 'Profile picture updated', pictureRemoved: 'Profile picture removed',
  },
  editor: {
    heading: 'Heading', bold: 'Bold', italic: 'Italic', strike: 'Strikethrough', code: 'Inline code', link: 'Link',
    bullets: 'Bulleted list', numbers: 'Numbered list', tasks: 'Checklist', quote: 'Quote', codeBlock: 'Code block', rule: 'Divider', table: 'Table', column: 'Column',
    saving: 'Saving…', saved: 'Saved', unsaved: 'Unsaved changes', saveFailed: 'Not saved, retrying…',
    placeholder: 'Write in Markdown… paste images, type - [ ] for a checklist',
  },
  filter: {
    title: 'Filters', status: 'Status', priority: 'Priority', due: 'Due date', any: 'Any', noStatus: 'No status',
    minStars_one: '{{count}}+ star', minStars_other: '{{count}}+ stars', noPriority: 'No stars',
    overdue: 'Overdue', today: 'Due today', week: 'Due within 7 days', none: 'No due date', has: 'Has a due date', owner: 'Owner',
    allOwners: 'All owners', ownedBy: 'Owner',
  },
  sort: {
    title: 'Sort cards by', priority: 'Priority (high first)', due: 'Due date (soonest first)', created: 'Newest first',
    createdAsc: 'Oldest first', updated: 'Recently updated', title_: 'Title (A–Z)', number: 'Card number', dragHint: 'Drag to reorder',
  },
  preview: {
    open: 'Preview', download: 'Download', unsupported: 'No preview for this file type.', tooBig: 'Too large to preview.',
    failed: 'Could not open this file for preview.', downloadOnly: 'download only',
  },
  calendar: {
    board: 'Board', calendar: 'Calendar', today: 'Today', month: 'Month', week: 'Week', unscheduled: 'No due date',
    dragHint: 'Drag onto a day to schedule; drag back here to clear the date.', more_one: '+{{count}} more', more_other: '+{{count}} more',
    addCard: 'Add card on this day', allBoards: 'All boards',
  },
  menu: {
    open: 'Open', newCard: 'New card', newCardOnDay: 'New card on this day', newCardTop: 'New card at top', newCardBottom: 'New card at bottom',
    duplicate: 'Duplicate', copyLink: 'Copy link', copyTitle: 'Copy number & title', linkCopied: 'Link copied', copied: 'Copied',
    moveTo: 'Move to', today: 'Today', tomorrow: 'Tomorrow', nextWeek: 'In a week', pickDate: 'Pick a date…', clearDue: 'Remove due date',
    assignMe: 'Assign to me', unassignMe: 'Unassign me', time: 'Time', openAfter: 'Open the card after creating it',
  },
  archive: {
    restore: 'Restore', columns: 'Archived columns', cards: 'Archived cards', noColumns: 'No archived columns.', archiveBoard: 'Archive board', deleteForever: 'Delete permanently',
    archiveBoardMsg: 'Archive “{{name}}”? It disappears from the board list but nothing is lost. You can restore it from Boards → Archived.',
    purgeBoardMsg: 'Permanently delete “{{name}}”? All its columns, {{cards}} cards, comments, history and attachments (including the stored files) will be erased. This cannot be undone.',
    purgeCardMsg: 'Permanently delete {{title}}? Its comments, history and attachments (including the stored files) will be erased. This cannot be undone.',
    archiveVsDelete: 'Archive hides the board and keeps everything (restore any time). Delete permanently erases it and its files.',
    boardsHint: 'Archived boards are hidden from everyone. Restore them, or delete them permanently.',
    cardsHint: 'Archived cards are hidden from the board. Restoring puts a card back at the bottom of its column.',
    noBoards: 'No archived boards.', noCards: 'No archived cards.', archivedAgo: 'archived {{when}}',
  },
  confirm: { typeToConfirm: 'Type “{{text}}” to confirm' },
  toast: {
    sorted: 'Sorted “{{name}}”', columnDeleted: 'Deleted column “{{name}}”', columnArchived: 'Archived column “{{name}}”',
    restored: 'Restored', deleted: 'Deleted permanently', archived: 'Archived “{{title}}”', duplicated: 'Duplicated “{{title}}”',
    moved: 'Moved “{{title}}” to {{to}}', uploaded_one: 'Uploaded 1 file', uploaded_other: 'Uploaded {{count}} files',
    cardCreated: 'Created “{{title}}”', boardCreated: 'Created board “{{name}}”', boardArchived: 'Archived board “{{name}}”',
    boardRestored: 'Restored board “{{name}}”', boardDeleted: 'Deleted board “{{name}}”', left: 'You left “{{name}}”',
    orderSaved: 'Board order saved',
  },
  column: {
    archive: 'Archive column',
    deleteMsg_one: 'Delete column “{{name}}” and its {{count}} card? Comments, history and attached files are erased for good.',
    deleteMsg_other: 'Delete column “{{name}}” and all {{count}} cards in it? Comments, history and attached files are erased for good.',
    deleteEmptyMsg: 'Delete the empty column “{{name}}”?',
  },
  activity: {
    added: 'added “{{title}}”', updated: 'updated “{{title}}”', comment: 'commented on “{{title}}”', attachment: 'attached a file to “{{title}}”',
    columns: 'changed the columns', settings: 'changed the board settings', archivedBoard: 'archived this board', card: 'changed a card',
  },
  presence: {
    viewing: 'Viewing this board', onCard: 'Viewing #{{number}} {{title}}', editingCard: 'Editing #{{number}} {{title}}', here: 'Also here',
    editing: 'editing…', you: 'you',
  },
  email: {
    title: 'Email settings', intro: 'Outgoing email for welcome links (new accounts) and “Forgot password”. Any SMTP server works (Gmail, Outlook/Microsoft 365, your provider…).',
    enabled: 'Send emails', host: 'SMTP server', port: 'Port', security: 'Encryption', noEncryption: 'None (local relay only)',
    username: 'SMTP username', passwordKept: 'Saved. Leave empty to keep it.', fromEmail: 'From address', fromName: 'From name',
    publicUrl: 'Site address used in links', publicUrlHint: 'Empty = the configured PUBLIC_ORIGIN.',
    gmailHint: 'Gmail: smtp.gmail.com, STARTTLS 587, your address as username and an App Password (Google Account → Security → App passwords).',
    test: 'Send a test email', testHint: 'Uses the saved settings: save first.', sendTest: 'Send test', sending: 'Sending…',
    testOk: 'Sent to {{to}}. Check the inbox (and spam folder).', testFailed: 'Failed',
  },
  errors: {
    unauthorized: 'Please sign in.', forbidden: 'You don’t have permission to do that.', not_found: 'Not found.',
    invalid_credentials: 'Wrong username/email or password.', invalid_email: 'That doesn’t look like a valid email address.', invalid_token: 'This link has expired or was already used.', email_disabled: 'Email is not set up on this server. Ask an administrator.', smtp_incomplete: 'Fill in the SMTP server and the From address.', cannot_delete_self: 'You can’t delete your own account.', email_taken: 'That email is already used by another account.', password_too_short: 'Password must be at least 8 characters.',
    invalid_username: 'Username: 2–40 letters, digits, . _ -', username_taken: 'That username is taken.',
    name_required: 'Name is required.', title_required: 'Title is required.', list_not_empty: 'Move or archive the cards first.',
    too_large: 'File is too large.', not_an_image: 'Only PNG, JPEG, GIF, WebP or AVIF images can be pasted.',
    last_owner: 'A board needs at least one owner.', role_in_use: 'Role is still assigned to members.',
    owner_role_fixed: 'The owner role cannot be changed.', already_member: 'Already a member.',
    cannot_demote_self: 'You cannot disable or demote yourself.', comment_empty: 'Comment is empty.',
    network: 'Network error.', internal: 'Something went wrong.',
  },
}

type Dict = { [k: string]: string | Dict }

const th: Dict = {
  app: { name: 'คัมบัง' },
  common: {
    save: 'บันทึก', cancel: 'ยกเลิก', delete: 'ลบ', edit: 'แก้ไข', close: 'ปิด', add: 'เพิ่ม', create: 'สร้าง',
    loading: 'กำลังโหลด…', search: 'ค้นหา', name: 'ชื่อ', description: 'รายละเอียด', color: 'สี', none: 'ไม่มี',
    confirmDelete: 'ต้องการลบใช่หรือไม่? ไม่สามารถย้อนกลับได้', yes: 'ใช่', no: 'ไม่', saved: 'บันทึกแล้ว', rename: 'เปลี่ยนชื่อ',
    back: 'กลับ', clear: 'ล้าง', remove: 'นำออก', done: 'เสร็จ', settings: 'ตั้งค่า',
  },
  auth: {
    signIn: 'เข้าสู่ระบบ', signOut: 'ออกจากระบบ', username: 'ชื่อผู้ใช้', usernameOrEmail: 'ชื่อผู้ใช้หรืออีเมล', forgot: 'ลืมรหัสผ่าน?', forgotTitle: 'ลืมรหัสผ่าน', forgotHint: 'กรอกชื่อผู้ใช้หรืออีเมล หากบัญชีมีอีเมล เราจะส่งลิงก์สำหรับตั้งรหัสผ่านใหม่ให้', sendLink: 'ส่งลิงก์', forgotSent: 'หากบัญชีนั้นมีอีเมล ระบบได้ส่งลิงก์ไปแล้ว ลิงก์ใช้ได้ 1 ชั่วโมง', backToSignIn: 'กลับไปหน้าเข้าสู่ระบบ', confirmPassword: 'ยืนยันรหัสผ่านใหม่', passwordsDiffer: 'รหัสผ่านไม่ตรงกัน', savePassword: 'บันทึกรหัสผ่าน', chooseNewPassword: 'ตั้งรหัสผ่านใหม่', forcedHint: 'สวัสดีคุณ {{name}} รหัสผ่านนี้ตั้งโดยผู้ดูแลระบบ กรุณาตั้งรหัสผ่านของคุณเองเพื่อใช้งานต่อ', welcomeSetPassword: 'ยินดีต้อนรับ! ตั้งรหัสผ่านของคุณ', forAccount: 'บัญชี: {{username}}', linkInvalidTitle: 'ลิงก์หมดอายุ', linkInvalid: 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว', requestNewLink: 'ขอลิงก์ใหม่', passwordSet: 'บันทึกรหัสผ่านแล้ว เข้าสู่ระบบได้เลย', password: 'รหัสผ่าน',
    welcome: 'เข้าสู่ระบบพื้นที่ทำงานของคุณ', noSignup: 'บัญชีผู้ใช้สร้างโดยผู้ดูแลระบบเท่านั้น',
  },
  nav: { boards: 'บอร์ด', calendar: 'ปฏิทิน', admin: 'ผู้ดูแลระบบ', profile: 'โปรไฟล์', language: 'ภาษา', theme: 'ธีม' },
  theme: { light: 'สว่าง', dark: 'มืด', system: 'ตามระบบ' },
  search: {
    placeholder: 'ค้นหาบอร์ดและการ์ด…', hint: 'ค้นหาทั้งหมด', noResults: 'ไม่พบผลลัพธ์', boards: 'บอร์ด', cards: 'การ์ด',
    filterCards: 'กรองการ์ด…', filterBoards: 'กรองบอร์ด…',
  },
  boards: {
    title: 'บอร์ด', new: 'สร้างบอร์ด', empty: 'ยังไม่มีบอร์ด', cards_one: '{{count}} การ์ด', cards_other: '{{count}} การ์ด',
    members_one: 'สมาชิก {{count}} คน', members_other: 'สมาชิก {{count}} คน', notMember: 'ไม่ได้เป็นสมาชิก (มุมมองผู้ดูแลสูงสุด)', tab_active: 'ใช้งาน', tab_archived: 'ที่เก็บ', addTutorial: 'เพิ่มบอร์ดแนะนำการใช้งาน', dragHint: 'ลากบอร์ดเพื่อจัดลำดับ (เปลี่ยนเฉพาะมุมมองของคุณ)', dragDisabled: 'ล้างตัวกรองก่อนจัดลำดับบอร์ด', showArchived: 'แสดงบอร์ดที่เก็บไว้', showActive: 'แสดงบอร์ดที่ใช้งาน', openNewTab: 'เปิดในแท็บใหม่', leaveMsg: 'ออกจาก “{{name}}” หรือไม่? คุณจะเข้าไม่ได้จนกว่าจะมีคนเพิ่มคุณอีกครั้ง',
    namePlaceholder: 'ชื่อบอร์ด', defaultLists: 'สิ่งที่ต้องทำ, กำลังทำ, เสร็จแล้ว', listsLabel: 'คอลัมน์ (คั่นด้วยจุลภาค)',
  },
  board: {
    addList: 'เพิ่มคอลัมน์', listName: 'ชื่อคอลัมน์', addCard: 'เพิ่มการ์ด', cardTitle: 'ชื่อการ์ด…', fold: 'ย่อ', unfold: 'ขยาย',
    wipLimit: 'จำกัดจำนวนงาน', wipPrompt: 'จำนวนการ์ดสูงสุดในคอลัมน์นี้ (เว้นว่าง = ไม่จำกัด)', deleteList: 'ลบคอลัมน์',
    settings: 'ตั้งค่าบอร์ด', onlyMine: 'งานของฉัน', labels: 'ป้ายกำกับ', filters: 'ตัวกรอง', clearFilters: 'ล้างตัวกรอง',
    readOnly: 'อ่านอย่างเดียว', overdue: 'เลยกำหนด', live: 'อัปเดตแบบเรียลไทม์', offline: 'กำลังเชื่อมต่อใหม่…',
  },
  card: {
    description: 'รายละเอียด', noDescription: 'ยังไม่มีรายละเอียด คลิกเพื่อเพิ่ม', write: 'เขียน', preview: 'ตัวอย่าง',
    attachments: 'ไฟล์แนบ', upload: 'อัปโหลดไฟล์', dropHere: 'วางไฟล์เพื่อแนบ', activity: 'กิจกรรม',
    comment: 'ความคิดเห็น', commentPlaceholder: 'เขียนความคิดเห็น… (Markdown, วางรูปได้)', post: 'ส่ง',
    column: 'คอลัมน์', assignees: 'ผู้รับผิดชอบ', labels: 'ป้ายกำกับ', priority: 'ความสำคัญ', status: 'สถานะ', due: 'กำหนดส่ง',
    color: 'สี', archive: 'เก็บการ์ด', archiveConfirm: 'เก็บการ์ดนี้หรือไม่? กู้คืนได้ที่ ตั้งค่าบอร์ด → ที่เก็บ', deleteAttachmentMsg: 'ลบไฟล์แนบ “{{name}}” หรือไม่? ไฟล์จะถูกลบออกจากที่เก็บข้อมูล', deleteCommentMsg: 'ลบความคิดเห็นนี้หรือไม่?', checklist: 'เช็กลิสต์',
    created: 'สร้างเมื่อ', updated: 'แก้ไขล่าสุด', uploading: 'กำลังอัปโหลด {{name}}… {{pct}}%', edited: 'แก้ไขแล้ว',
    markdownHint: 'รองรับ Markdown · วางหรือลากรูปภาพได้', editDescription: 'แก้ไขรายละเอียด',
    status_normal: 'กำลังดำเนินการ', status_blocked: 'ติดปัญหา', status_ready: 'พร้อม',
  },
  event: {
    created: 'สร้างการ์ดนี้ใน {{list}}', title: 'เปลี่ยนชื่อการ์ดจาก “{{from}}” เป็น “{{to}}”',
    description: 'แก้ไขรายละเอียด', priority: 'เปลี่ยนความสำคัญจาก {{from}} เป็น {{to}}',
    status: 'เปลี่ยนสถานะจาก {{from}} เป็น {{to}}', noStatus: 'ไม่มี', color: 'เปลี่ยนสี', due: 'เปลี่ยนกำหนดส่งเป็น {{to}}',
    dueCleared: 'ลบกำหนดส่ง', moved: 'ย้ายการ์ดจาก {{from}} ไป {{to}}', archived: 'เก็บการ์ดนี้', restored: 'กู้คืนการ์ดนี้',
    labels: 'เปลี่ยนป้ายกำกับ', assignees: 'เปลี่ยนผู้รับผิดชอบ', added: 'เพิ่ม {{items}}', removed: 'นำออก {{items}}',
    attachment_added: 'แนบไฟล์ {{filename}}', duplicated: 'สร้างการ์ดนี้โดยคัดลอกจาก #{{from}}', attachment_removed: 'ลบไฟล์แนบ {{filename}}',
  },
  settings: {
    title: 'ตั้งค่าบอร์ด', general: 'ทั่วไป', members: 'สมาชิก', roles: 'บทบาทและสิทธิ์', labels: 'ป้ายกำกับ', archive: 'ที่เก็บ', statuses: 'สถานะ', newStatus: 'สถานะใหม่', statusHint: 'แสดงเป็นจุดสีบนการ์ดและแถบความคืบหน้าของคอลัมน์ การ์ดใหม่จะได้สถานะแรก',
    addMember: 'เพิ่มสมาชิก', removeMemberMsg: 'นำ {{name}} ออกจากบอร์ดนี้หรือไม่?', deleteRoleMsg: 'ลบบทบาท “{{name}}” หรือไม่?', deleteLabelMsg: 'ลบป้าย “{{name}}” หรือไม่? ป้ายจะถูกนำออกจากทุกการ์ด', deleteStatusMsg: 'ลบสถานะ “{{name}}” หรือไม่? การ์ดที่ใช้สถานะนี้จะไม่มีสถานะ', role: 'บทบาท', newRole: 'บทบาทใหม่', owner: 'เจ้าของ (ทุกสิทธิ์)', deleteBoard: 'ลบบอร์ด',
    deleteBoardConfirm: 'ต้องการลบบอร์ดนี้สำหรับทุกคนหรือไม่?', leave: 'ออกจากบอร์ด', newLabel: 'ป้ายกำกับใหม่',
  },
  perm: {
    'board.manage': 'แก้ไขการตั้งค่าบอร์ด', 'board.delete': 'ลบบอร์ด', 'members.manage': 'จัดการสมาชิกและบทบาท',
    'lists.manage': 'จัดการคอลัมน์', 'labels.manage': 'จัดการป้ายกำกับ', 'cards.create': 'สร้างการ์ด', 'cards.edit': 'แก้ไขการ์ด',
    'cards.move': 'ย้ายการ์ด', 'cards.delete': 'เก็บการ์ด', 'comments.create': 'แสดงความคิดเห็น',
    'comments.moderate': 'ลบความคิดเห็นของผู้อื่น', 'attachments.upload': 'อัปโหลดไฟล์แนบ', 'attachments.delete': 'ลบไฟล์แนบใดก็ได้',
  },
  admin: {
    title: 'ผู้ใช้', newUser: 'เพิ่มผู้ใช้', displayName: 'ชื่อที่แสดง', email: 'อีเมล', superAdmin: 'ผู้ดูแลสูงสุด', search: 'ค้นหาชื่อ ชื่อผู้ใช้ หรืออีเมล…', count_one: '{{count}} คน', count_other: '{{count}} คน', mustChange: 'ต้องเปลี่ยนรหัสผ่าน', deleteUser: 'ลบผู้ใช้', generate: 'สุ่ม', copy: 'คัดลอก', showPassword: 'แสดงรหัสผ่าน', passwordHint: 'อย่างน้อย 8 ตัวอักษร ผู้ใช้ต้องเปลี่ยนเมื่อเข้าสู่ระบบครั้งแรก', sendInvite: 'ส่งลิงก์เข้าสู่ระบบทางอีเมล', sendInviteHint: 'ผู้ใช้จะได้รับลิงก์สำหรับตั้งรหัสผ่านเอง (ใช้ได้ 3 วัน)', emailNotSetUp: 'ตั้งค่าอีเมล (แท็บตั้งค่าอีเมล) และกรอกอีเมลก่อน', userCreated: 'สร้าง {{name}} แล้ว', inviteSent: 'ส่งลิงก์ไปที่ {{email}} แล้ว', inviteFailed: 'ส่งอีเมลไม่สำเร็จ', handOver: 'ข้อมูลเข้าสู่ระบบสำหรับส่งต่อ (แสดงรหัสผ่านครั้งเดียว):', mustChangeHint: 'ผู้ใช้ต้องตั้งรหัสผ่านของตัวเองเมื่อเข้าสู่ระบบ', copyDetails: 'คัดลอกข้อมูล', signInAt: 'เข้าสู่ระบบที่', passwordCopied: 'คัดลอกรหัสผ่านใหม่แล้ว', passwordReset: 'รีเซ็ตรหัสผ่านของ {{name}} แล้ว', resetLinkSent: 'ส่งลิงก์รีเซ็ตไปที่ {{email}} แล้ว', emailLinkHint: 'แนะนำ: ส่งลิงก์รีเซ็ตไปที่ {{email}} เพื่อให้มีเพียงผู้ใช้ที่รู้รหัสผ่านใหม่', emailResetLink: 'ส่งลิงก์รีเซ็ตทางอีเมล', setPassword: 'ตั้งรหัสผ่านนี้', userDeleted: 'ลบ {{name}} แล้ว', delBoardsDeleted_one: 'บอร์ดนี้จะถูกลบ (มีผู้ใช้นี้คนเดียว):', delBoardsDeleted_other: 'บอร์ด {{count}} บอร์ดนี้จะถูกลบ (มีผู้ใช้นี้คนเดียว):', delNewOwner_one: 'บอร์ดที่ใช้ร่วมกันนี้จะได้เจ้าของใหม่ (สมาชิกที่อยู่นานที่สุด):', delNewOwner_other: 'บอร์ดที่ใช้ร่วมกัน {{count}} บอร์ดนี้จะได้เจ้าของใหม่ (สมาชิกที่อยู่นานที่สุด):', delRemovedFrom_one: 'จะถูกนำออกจากบอร์ดที่ใช้ร่วมกันอีก 1 บอร์ด', delRemovedFrom_other: 'จะถูกนำออกจากบอร์ดที่ใช้ร่วมกันอีก {{count}} บอร์ด', delHistory: 'ความคิดเห็นและกิจกรรมยังอยู่ โดยแสดงเป็น “{{label}}” ชื่อผู้ใช้และอีเมลนำกลับมาใช้ใหม่ได้', emailHint: 'ใช้เข้าสู่ระบบได้ เว้นว่างเพื่อลบ',
    canCreateBoards: 'สร้างบอร์ดได้', active: 'ใช้งาน', inactive: 'ปิดใช้งาน', resetPassword: 'รีเซ็ตรหัสผ่าน',
    newPassword: 'รหัสผ่านใหม่', languageHint: 'ใช้เป็นภาษาของบอร์ด “เริ่มต้นใช้งาน” ด้วย', disable: 'ปิดใช้งาน', enable: 'เปิดใช้งาน', you: 'คุณ',
  },
  profile: {
    title: 'โปรไฟล์', changePassword: 'เปลี่ยนรหัสผ่าน', currentPassword: 'รหัสผ่านปัจจุบัน', newPassword: 'รหัสผ่านใหม่',
    passwordChanged: 'เปลี่ยนรหัสผ่านแล้ว อุปกรณ์อื่นถูกออกจากระบบ', uploadPicture: 'อัปโหลดรูป', changePicture: 'เปลี่ยนรูป', pictureHint: 'PNG, JPEG, WebP หรือ GIF ไม่เกิน 10 MB รูปจะถูกครอปเป็นสี่เหลี่ยมจัตุรัส และลบข้อมูลตำแหน่งในรูปออก หากไม่มีรูปจะแสดงอักษรย่อและสีของคุณ', pictureSaved: 'อัปเดตรูปโปรไฟล์แล้ว', pictureRemoved: 'ลบรูปโปรไฟล์แล้ว',
  },
  editor: {
    heading: 'หัวข้อ', bold: 'ตัวหนา', italic: 'ตัวเอียง', strike: 'ขีดฆ่า', code: 'โค้ด', link: 'ลิงก์',
    bullets: 'รายการจุด', numbers: 'รายการตัวเลข', tasks: 'เช็กลิสต์', quote: 'อ้างอิง', codeBlock: 'บล็อกโค้ด', rule: 'เส้นคั่น', table: 'ตาราง', column: 'คอลัมน์',
    saving: 'กำลังบันทึก…', saved: 'บันทึกแล้ว', unsaved: 'ยังไม่บันทึก', saveFailed: 'บันทึกไม่สำเร็จ กำลังลองใหม่…',
    placeholder: 'เขียนด้วย Markdown… วางรูปได้ พิมพ์ - [ ] เพื่อสร้างเช็กลิสต์',
  },
  filter: {
    title: 'ตัวกรอง', status: 'สถานะ', priority: 'ความสำคัญ', due: 'กำหนดส่ง', any: 'ทั้งหมด', noStatus: 'ไม่มีสถานะ',
    minStars_one: '{{count}} ดาวขึ้นไป', minStars_other: '{{count}} ดาวขึ้นไป', noPriority: 'ไม่มีดาว',
    overdue: 'เลยกำหนด', today: 'ครบกำหนดวันนี้', week: 'ครบกำหนดใน 7 วัน', none: 'ไม่มีกำหนดส่ง', has: 'มีกำหนดส่ง', owner: 'เจ้าของ',
    allOwners: 'เจ้าของทั้งหมด', ownedBy: 'เจ้าของ',
  },
  sort: {
    title: 'เรียงการ์ดตาม', priority: 'ความสำคัญ (มากไปน้อย)', due: 'กำหนดส่ง (ใกล้สุดก่อน)', created: 'ใหม่สุดก่อน',
    createdAsc: 'เก่าสุดก่อน', updated: 'แก้ไขล่าสุด', title_: 'ชื่อ (ก–ฮ, A–Z)', number: 'หมายเลขการ์ด', dragHint: 'ลากเพื่อจัดลำดับ',
  },
  preview: {
    open: 'ดูตัวอย่าง', download: 'ดาวน์โหลด', unsupported: 'ไม่รองรับการแสดงตัวอย่างไฟล์ประเภทนี้', tooBig: 'ไฟล์ใหญ่เกินกว่าจะแสดงตัวอย่าง',
    failed: 'ไม่สามารถเปิดไฟล์นี้เพื่อแสดงตัวอย่างได้', downloadOnly: 'ดาวน์โหลดเท่านั้น',
  },
  calendar: {
    board: 'บอร์ด', calendar: 'ปฏิทิน', today: 'วันนี้', month: 'เดือน', week: 'สัปดาห์', unscheduled: 'ไม่มีกำหนดส่ง',
    dragHint: 'ลากไปวางบนวันที่เพื่อกำหนดวัน ลากกลับมาที่นี่เพื่อลบวันที่', more_one: 'อีก {{count}} รายการ', more_other: 'อีก {{count}} รายการ',
    addCard: 'เพิ่มการ์ดในวันนี้', allBoards: 'ทุกบอร์ด',
  },
  menu: {
    open: 'เปิด', newCard: 'การ์ดใหม่', newCardOnDay: 'สร้างการ์ดในวันนี้', newCardTop: 'การ์ดใหม่ด้านบน', newCardBottom: 'การ์ดใหม่ด้านล่าง',
    duplicate: 'ทำสำเนา', copyLink: 'คัดลอกลิงก์', copyTitle: 'คัดลอกหมายเลขและชื่อ', linkCopied: 'คัดลอกลิงก์แล้ว', copied: 'คัดลอกแล้ว',
    moveTo: 'ย้ายไป', today: 'วันนี้', tomorrow: 'พรุ่งนี้', nextWeek: 'อีก 1 สัปดาห์', pickDate: 'เลือกวันที่…', clearDue: 'ลบกำหนดส่ง',
    assignMe: 'มอบหมายให้ฉัน', unassignMe: 'ยกเลิกการมอบหมายฉัน', time: 'เวลา', openAfter: 'เปิดการ์ดหลังสร้าง',
  },
  archive: {
    restore: 'กู้คืน', columns: 'คอลัมน์ที่เก็บ', cards: 'การ์ดที่เก็บ', noColumns: 'ไม่มีคอลัมน์ที่เก็บไว้', archiveBoard: 'เก็บบอร์ด', deleteForever: 'ลบถาวร',
    archiveBoardMsg: 'เก็บ “{{name}}” หรือไม่? บอร์ดจะหายจากรายการแต่ข้อมูลยังอยู่ครบ กู้คืนได้ที่ บอร์ด → ที่เก็บ',
    purgeBoardMsg: 'ลบ “{{name}}” ถาวรหรือไม่? คอลัมน์ทั้งหมด การ์ด {{cards}} ใบ ความคิดเห็น ประวัติ และไฟล์แนบ (รวมไฟล์ในที่เก็บข้อมูล) จะถูกลบ ย้อนกลับไม่ได้',
    purgeCardMsg: 'ลบ {{title}} ถาวรหรือไม่? ความคิดเห็น ประวัติ และไฟล์แนบ (รวมไฟล์ในที่เก็บข้อมูล) จะถูกลบ ย้อนกลับไม่ได้',
    archiveVsDelete: 'เก็บ = ซ่อนบอร์ดโดยข้อมูลยังอยู่ (กู้คืนได้) · ลบถาวร = ลบบอร์ดและไฟล์ทั้งหมด',
    boardsHint: 'บอร์ดที่เก็บจะถูกซ่อนจากทุกคน กู้คืนหรือลบถาวรได้ที่นี่',
    cardsHint: 'การ์ดที่เก็บจะถูกซ่อนจากบอร์ด เมื่อกู้คืนจะกลับไปอยู่ล่างสุดของคอลัมน์เดิม',
    noBoards: 'ไม่มีบอร์ดที่เก็บไว้', noCards: 'ไม่มีการ์ดที่เก็บไว้', archivedAgo: 'เก็บเมื่อ {{when}}',
  },
  confirm: { typeToConfirm: 'พิมพ์ “{{text}}” เพื่อยืนยัน' },
  toast: {
    sorted: 'เรียง “{{name}}” แล้ว', columnDeleted: 'ลบคอลัมน์ “{{name}}” แล้ว', columnArchived: 'เก็บคอลัมน์ “{{name}}” แล้ว',
    restored: 'กู้คืนแล้ว', deleted: 'ลบถาวรแล้ว', archived: 'เก็บ “{{title}}” แล้ว', duplicated: 'ทำสำเนา “{{title}}” แล้ว',
    moved: 'ย้าย “{{title}}” ไป {{to}} แล้ว', uploaded_one: 'อัปโหลด 1 ไฟล์แล้ว', uploaded_other: 'อัปโหลด {{count}} ไฟล์แล้ว',
    cardCreated: 'สร้าง “{{title}}” แล้ว', boardCreated: 'สร้างบอร์ด “{{name}}” แล้ว', boardArchived: 'เก็บบอร์ด “{{name}}” แล้ว',
    boardRestored: 'กู้คืนบอร์ด “{{name}}” แล้ว', boardDeleted: 'ลบบอร์ด “{{name}}” แล้ว', left: 'ออกจาก “{{name}}” แล้ว',
    orderSaved: 'บันทึกลำดับบอร์ดแล้ว',
  },
  column: {
    archive: 'เก็บคอลัมน์',
    deleteMsg_one: 'ลบคอลัมน์ “{{name}}” พร้อมการ์ด {{count}} ใบหรือไม่? ความคิดเห็น ประวัติ และไฟล์แนบจะถูกลบถาวร',
    deleteMsg_other: 'ลบคอลัมน์ “{{name}}” พร้อมการ์ดทั้งหมด {{count}} ใบหรือไม่? ความคิดเห็น ประวัติ และไฟล์แนบจะถูกลบถาวร',
    deleteEmptyMsg: 'ลบคอลัมน์ว่าง “{{name}}” หรือไม่?',
  },
  activity: {
    added: 'เพิ่ม “{{title}}”', updated: 'แก้ไข “{{title}}”', comment: 'แสดงความคิดเห็นใน “{{title}}”', attachment: 'แนบไฟล์ใน “{{title}}”',
    columns: 'เปลี่ยนคอลัมน์', settings: 'เปลี่ยนการตั้งค่าบอร์ด', archivedBoard: 'เก็บบอร์ดนี้', card: 'แก้ไขการ์ด',
  },
  presence: {
    viewing: 'กำลังดูบอร์ดนี้', onCard: 'กำลังดู #{{number}} {{title}}', editingCard: 'กำลังแก้ไข #{{number}} {{title}}', here: 'กำลังดูอยู่ด้วย',
    editing: 'กำลังแก้ไข…', you: 'คุณ',
  },
  email: {
    title: 'ตั้งค่าอีเมล', intro: 'อีเมลขาออกสำหรับลิงก์ต้อนรับ (บัญชีใหม่) และ “ลืมรหัสผ่าน” ใช้เซิร์ฟเวอร์ SMTP ใดก็ได้ (Gmail, Outlook/Microsoft 365 ฯลฯ)',
    enabled: 'ส่งอีเมล', host: 'เซิร์ฟเวอร์ SMTP', port: 'พอร์ต', security: 'การเข้ารหัส', noEncryption: 'ไม่เข้ารหัส (เฉพาะ relay ภายใน)',
    username: 'ชื่อผู้ใช้ SMTP', passwordKept: 'บันทึกไว้แล้ว เว้นว่างเพื่อใช้ค่าเดิม', fromEmail: 'อีเมลผู้ส่ง', fromName: 'ชื่อผู้ส่ง',
    publicUrl: 'ที่อยู่เว็บที่ใช้ในลิงก์', publicUrlHint: 'เว้นว่าง = ใช้ค่า PUBLIC_ORIGIN',
    gmailHint: 'Gmail: smtp.gmail.com, STARTTLS 587, ใช้อีเมลเป็นชื่อผู้ใช้ และใช้ App Password (บัญชี Google → ความปลอดภัย → รหัสผ่านสำหรับแอป)',
    test: 'ส่งอีเมลทดสอบ', testHint: 'ใช้การตั้งค่าที่บันทึกแล้ว: กดบันทึกก่อน', sendTest: 'ส่งทดสอบ', sending: 'กำลังส่ง…',
    testOk: 'ส่งไปที่ {{to}} แล้ว ตรวจกล่องจดหมาย (และโฟลเดอร์สแปม)', testFailed: 'ไม่สำเร็จ',
  },
  errors: {
    unauthorized: 'กรุณาเข้าสู่ระบบ', forbidden: 'คุณไม่มีสิทธิ์ทำรายการนี้', not_found: 'ไม่พบข้อมูล',
    invalid_credentials: 'ชื่อผู้ใช้/อีเมล หรือรหัสผ่านไม่ถูกต้อง', invalid_email: 'รูปแบบอีเมลไม่ถูกต้อง', invalid_token: 'ลิงก์นี้หมดอายุหรือถูกใช้ไปแล้ว', email_disabled: 'เซิร์ฟเวอร์นี้ยังไม่ได้ตั้งค่าอีเมล กรุณาติดต่อผู้ดูแลระบบ', smtp_incomplete: 'กรอกเซิร์ฟเวอร์ SMTP และอีเมลผู้ส่ง', cannot_delete_self: 'ไม่สามารถลบบัญชีของตัวเองได้', email_taken: 'อีเมลนี้ถูกใช้กับบัญชีอื่นแล้ว', password_too_short: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร',
    invalid_username: 'ชื่อผู้ใช้: 2–40 ตัว ใช้ตัวอักษร ตัวเลข . _ -', username_taken: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว',
    name_required: 'กรุณากรอกชื่อ', title_required: 'กรุณากรอกชื่อการ์ด', list_not_empty: 'ย้ายหรือเก็บการ์ดในคอลัมน์ก่อน',
    too_large: 'ไฟล์มีขนาดใหญ่เกินไป', not_an_image: 'วางได้เฉพาะรูป PNG, JPEG, GIF, WebP หรือ AVIF',
    last_owner: 'บอร์ดต้องมีเจ้าของอย่างน้อยหนึ่งคน', role_in_use: 'ยังมีสมาชิกใช้บทบาทนี้อยู่',
    owner_role_fixed: 'ไม่สามารถแก้ไขบทบาทเจ้าของได้', already_member: 'เป็นสมาชิกอยู่แล้ว',
    cannot_demote_self: 'ไม่สามารถปิดใช้งานหรือลดสิทธิ์ตัวเองได้', comment_empty: 'ความคิดเห็นว่างเปล่า',
    network: 'การเชื่อมต่อขัดข้อง', internal: 'เกิดข้อผิดพลาด',
  },
}

function initialLocale(): 'en' | 'th' {
  try {
    const l = localStorage.getItem('locale')
    if (l === 'en' || l === 'th') return l
  } catch {
    /* ignore */
  }
  return navigator.language.startsWith('th') ? 'th' : 'en'
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, th: { translation: th } },
  lng: initialLocale(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export function setLocale(l: 'en' | 'th') {
  i18n.changeLanguage(l)
  document.documentElement.lang = l
  try {
    localStorage.setItem('locale', l)
  } catch {
    /* ignore */
  }
}

/** Translate an API error code. */
export function errorText(e: unknown): string {
  const code = (e as { code?: string })?.code ?? 'internal'
  return i18n.exists(`errors.${code}`) ? i18n.t(`errors.${code}`) : i18n.t('errors.internal')
}

export default i18n
