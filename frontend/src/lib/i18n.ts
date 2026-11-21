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
    signIn: 'Sign in', signOut: 'Sign out', username: 'Username', password: 'Password',
    welcome: 'Sign in to your workspace', noSignup: 'Accounts are created by an administrator.',
  },
  nav: { boards: 'Boards', admin: 'Users', profile: 'Profile', language: 'Language', theme: 'Theme' },
  theme: { light: 'Light', dark: 'Dark', system: 'System' },
  search: {
    placeholder: 'Search boards and cards…', hint: 'Search everything', noResults: 'No results', boards: 'Boards', cards: 'Cards',
    filterCards: 'Filter cards…', filterBoards: 'Filter boards…',
  },
  boards: {
    title: 'Boards', new: 'New board', empty: 'No boards yet.', cards_one: '{{count}} card', cards_other: '{{count}} cards',
    members_one: '{{count}} member', members_other: '{{count}} members', notMember: 'Not a member (super admin view)',
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
    color: 'Color', archive: 'Archive card', archiveConfirm: 'Archive this card?', checklist: 'Checklist',
    created: 'Created', updated: 'Updated', uploading: 'Uploading {{name}}… {{pct}}%', edited: 'edited',
    markdownHint: 'Markdown supported · paste or drop images', editDescription: 'Edit description',
    status_normal: 'In progress', status_blocked: 'Blocked', status_ready: 'Ready',
  },
  event: {
    created: 'created this card in {{list}}', title: 'renamed the card from “{{from}}” to “{{to}}”',
    description: 'updated the description', priority: 'changed priority from {{from}} to {{to}}',
    status: 'changed status from {{from}} to {{to}}', color: 'changed the color', due: 'changed the due date to {{to}}',
    dueCleared: 'removed the due date', moved: 'moved this card from {{from}} to {{to}}', archived: 'archived this card',
    labels: 'changed labels', assignees: 'changed assignees', added: 'added {{items}}', removed: 'removed {{items}}',
    attachment_added: 'attached {{filename}}', attachment_removed: 'removed attachment {{filename}}',
  },
  settings: {
    title: 'Board settings', general: 'General', members: 'Members', roles: 'Roles & permissions', labels: 'Labels',
    addMember: 'Add member', role: 'Role', newRole: 'New role', owner: 'Owner (all permissions)', deleteBoard: 'Delete board',
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
    title: 'Users', newUser: 'New user', displayName: 'Display name', email: 'Email', superAdmin: 'Super admin',
    canCreateBoards: 'Can create boards', active: 'Active', inactive: 'Disabled', resetPassword: 'Reset password',
    newPassword: 'New password', disable: 'Disable', enable: 'Enable', you: 'you',
  },
  profile: {
    title: 'Profile', changePassword: 'Change password', currentPassword: 'Current password', newPassword: 'New password',
    passwordChanged: 'Password changed. Other sessions were signed out.',
  },
  errors: {
    unauthorized: 'Please sign in.', forbidden: 'You don’t have permission to do that.', not_found: 'Not found.',
    invalid_credentials: 'Wrong username or password.', password_too_short: 'Password must be at least 8 characters.',
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
    signIn: 'เข้าสู่ระบบ', signOut: 'ออกจากระบบ', username: 'ชื่อผู้ใช้', password: 'รหัสผ่าน',
    welcome: 'เข้าสู่ระบบพื้นที่ทำงานของคุณ', noSignup: 'บัญชีผู้ใช้สร้างโดยผู้ดูแลระบบเท่านั้น',
  },
  nav: { boards: 'บอร์ด', admin: 'ผู้ใช้', profile: 'โปรไฟล์', language: 'ภาษา', theme: 'ธีม' },
  theme: { light: 'สว่าง', dark: 'มืด', system: 'ตามระบบ' },
  search: {
    placeholder: 'ค้นหาบอร์ดและการ์ด…', hint: 'ค้นหาทั้งหมด', noResults: 'ไม่พบผลลัพธ์', boards: 'บอร์ด', cards: 'การ์ด',
    filterCards: 'กรองการ์ด…', filterBoards: 'กรองบอร์ด…',
  },
  boards: {
    title: 'บอร์ด', new: 'สร้างบอร์ด', empty: 'ยังไม่มีบอร์ด', cards_one: '{{count}} การ์ด', cards_other: '{{count}} การ์ด',
    members_one: 'สมาชิก {{count}} คน', members_other: 'สมาชิก {{count}} คน', notMember: 'ไม่ได้เป็นสมาชิก (มุมมองผู้ดูแลสูงสุด)',
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
    color: 'สี', archive: 'เก็บการ์ด', archiveConfirm: 'ต้องการเก็บการ์ดนี้หรือไม่?', checklist: 'เช็กลิสต์',
    created: 'สร้างเมื่อ', updated: 'แก้ไขล่าสุด', uploading: 'กำลังอัปโหลด {{name}}… {{pct}}%', edited: 'แก้ไขแล้ว',
    markdownHint: 'รองรับ Markdown · วางหรือลากรูปภาพได้', editDescription: 'แก้ไขรายละเอียด',
    status_normal: 'กำลังดำเนินการ', status_blocked: 'ติดปัญหา', status_ready: 'พร้อม',
  },
  event: {
    created: 'สร้างการ์ดนี้ใน {{list}}', title: 'เปลี่ยนชื่อการ์ดจาก “{{from}}” เป็น “{{to}}”',
    description: 'แก้ไขรายละเอียด', priority: 'เปลี่ยนความสำคัญจาก {{from}} เป็น {{to}}',
    status: 'เปลี่ยนสถานะจาก {{from}} เป็น {{to}}', color: 'เปลี่ยนสี', due: 'เปลี่ยนกำหนดส่งเป็น {{to}}',
    dueCleared: 'ลบกำหนดส่ง', moved: 'ย้ายการ์ดจาก {{from}} ไป {{to}}', archived: 'เก็บการ์ดนี้',
    labels: 'เปลี่ยนป้ายกำกับ', assignees: 'เปลี่ยนผู้รับผิดชอบ', added: 'เพิ่ม {{items}}', removed: 'นำออก {{items}}',
    attachment_added: 'แนบไฟล์ {{filename}}', attachment_removed: 'ลบไฟล์แนบ {{filename}}',
  },
  settings: {
    title: 'ตั้งค่าบอร์ด', general: 'ทั่วไป', members: 'สมาชิก', roles: 'บทบาทและสิทธิ์', labels: 'ป้ายกำกับ',
    addMember: 'เพิ่มสมาชิก', role: 'บทบาท', newRole: 'บทบาทใหม่', owner: 'เจ้าของ (ทุกสิทธิ์)', deleteBoard: 'ลบบอร์ด',
    deleteBoardConfirm: 'ต้องการลบบอร์ดนี้สำหรับทุกคนหรือไม่?', leave: 'ออกจากบอร์ด', newLabel: 'ป้ายกำกับใหม่',
  },
  perm: {
    'board.manage': 'แก้ไขการตั้งค่าบอร์ด', 'board.delete': 'ลบบอร์ด', 'members.manage': 'จัดการสมาชิกและบทบาท',
    'lists.manage': 'จัดการคอลัมน์', 'labels.manage': 'จัดการป้ายกำกับ', 'cards.create': 'สร้างการ์ด', 'cards.edit': 'แก้ไขการ์ด',
    'cards.move': 'ย้ายการ์ด', 'cards.delete': 'เก็บการ์ด', 'comments.create': 'แสดงความคิดเห็น',
    'comments.moderate': 'ลบความคิดเห็นของผู้อื่น', 'attachments.upload': 'อัปโหลดไฟล์แนบ', 'attachments.delete': 'ลบไฟล์แนบใดก็ได้',
  },
  admin: {
    title: 'ผู้ใช้', newUser: 'เพิ่มผู้ใช้', displayName: 'ชื่อที่แสดง', email: 'อีเมล', superAdmin: 'ผู้ดูแลสูงสุด',
    canCreateBoards: 'สร้างบอร์ดได้', active: 'ใช้งาน', inactive: 'ปิดใช้งาน', resetPassword: 'รีเซ็ตรหัสผ่าน',
    newPassword: 'รหัสผ่านใหม่', disable: 'ปิดใช้งาน', enable: 'เปิดใช้งาน', you: 'คุณ',
  },
  profile: {
    title: 'โปรไฟล์', changePassword: 'เปลี่ยนรหัสผ่าน', currentPassword: 'รหัสผ่านปัจจุบัน', newPassword: 'รหัสผ่านใหม่',
    passwordChanged: 'เปลี่ยนรหัสผ่านแล้ว อุปกรณ์อื่นถูกออกจากระบบ',
  },
  errors: {
    unauthorized: 'กรุณาเข้าสู่ระบบ', forbidden: 'คุณไม่มีสิทธิ์ทำรายการนี้', not_found: 'ไม่พบข้อมูล',
    invalid_credentials: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', password_too_short: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร',
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
