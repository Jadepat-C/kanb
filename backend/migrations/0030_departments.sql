-- Departments: super admins create them (Admin → Departments) and put people in one. Shown next to people's names,
-- and boards can be grouped into lanes by department.
CREATE TABLE departments (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    color text NOT NULL DEFAULT '#64748b',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX departments_name ON departments (lower(name));
ALTER TABLE users ADD COLUMN department_id uuid REFERENCES departments(id) ON DELETE SET NULL;
CREATE INDEX users_department ON users (department_id) WHERE department_id IS NOT NULL;
