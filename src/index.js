const core = require("@actions/core");
const fs = require("fs");
const path = require("path");

const DANGEROUS_PATTERNS = {
  postgres: [
    {
      id: "MG001",
      pattern: /\bDROP\s+TABLE\b/i,
      level: "error",
      message: "DROP TABLE will permanently delete data",
      suggestion: "Rename the table first, drop in a future migration after confirming no references remain",
    },
    {
      id: "MG002",
      pattern: /\bDROP\s+COLUMN\b/i,
      level: "error",
      message: "DROP COLUMN causes immediate data loss",
      suggestion: "Mark column as deprecated, stop writing to it, then drop in a later migration",
    },
    {
      id: "MG003",
      pattern: /\bALTER\s+TABLE\s+\w+\s+ADD\s+(?:COLUMN\s+)?\w+.*\bNOT\s+NULL\b(?!.*\bDEFAULT\b)/i,
      level: "error",
      message: "Adding NOT NULL column without DEFAULT locks table and fails on existing rows",
      suggestion: "Add the column as nullable or with a DEFAULT value",
    },
    {
      id: "MG004",
      pattern: /\bALTER\s+TABLE\s+\w+\s+ALTER\s+COLUMN\s+\w+\s+(?:SET\s+DATA\s+)?TYPE\b/i,
      level: "warning",
      message: "Changing column type may require full table rewrite and lock",
      suggestion: "For large tables, create a new column, backfill, then swap",
    },
    {
      id: "MG005",
      pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?!.*\bCONCURRENTLY\b)/i,
      level: "warning",
      message: "CREATE INDEX without CONCURRENTLY locks the table for writes",
      suggestion: "Use CREATE INDEX CONCURRENTLY to avoid blocking writes",
    },
    {
      id: "MG006",
      pattern: /\bLOCK\s+TABLE\b/i,
      level: "error",
      message: "Explicit table lock detected",
      suggestion: "Avoid explicit locks in migrations; restructure to use row-level locks",
    },
    {
      id: "MG007",
      pattern: /\bTRUNCATE\b/i,
      level: "error",
      message: "TRUNCATE deletes all rows and cannot be rolled back in some contexts",
      suggestion: "Use DELETE with conditions if partial removal is intended",
    },
    {
      id: "MG008",
      pattern: /\bALTER\s+TABLE\s+\w+\s+RENAME\s+COLUMN\b/i,
      level: "warning",
      message: "Renaming a column breaks existing queries using the old name",
      suggestion: "Use a multi-step migration: add new column, copy data, update code, drop old",
    },
    {
      id: "MG009",
      pattern: /\bALTER\s+TABLE\s+\w+\s+ADD\s+(?:CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY\b(?!.*\bNOT\s+VALID\b)/i,
      level: "warning",
      message: "Adding FK constraint validates all existing rows, locking the table",
      suggestion: "Add with NOT VALID first, then VALIDATE CONSTRAINT in a separate transaction",
    },
    {
      id: "MG010",
      pattern: /\bUPDATE\s+\w+\s+SET\b(?!.*\bWHERE\b)/i,
      level: "warning",
      message: "UPDATE without WHERE clause affects all rows — may be intentional but risky",
      suggestion: "Add a WHERE clause or process in batches to avoid long locks",
    },
    {
      id: "MG011",
      pattern: /\bALTER\s+TABLE\s+\w+\s+RENAME\s+TO\b/i,
      level: "warning",
      message: "Renaming a table breaks all references to the old name",
      suggestion: "Create a view with the old name pointing to the new table during transition",
    },
    {
      id: "MG012",
      pattern: /\bALTER\s+TYPE\b.*\bADD\s+VALUE\b/i,
      level: "info",
      message: "Adding enum value — cannot be done inside a transaction in Postgres",
      suggestion: "Ensure this runs outside a transaction block",
    },
  ],
  mysql: [
    {
      id: "MG001",
      pattern: /\bDROP\s+TABLE\b/i,
      level: "error",
      message: "DROP TABLE will permanently delete data",
      suggestion: "Rename first, drop later",
    },
    {
      id: "MG002",
      pattern: /\bDROP\s+COLUMN\b/i,
      level: "error",
      message: "DROP COLUMN causes data loss",
      suggestion: "Deprecate first, drop in a future migration",
    },
    {
      id: "MG003",
      pattern: /\bALTER\s+TABLE\b.*\bADD\b.*\bNOT\s+NULL\b(?!.*\bDEFAULT\b)/i,
      level: "error",
      message: "NOT NULL column without DEFAULT — table copy required",
      suggestion: "Add DEFAULT or make nullable",
    },
    {
      id: "MG005",
      pattern: /\bALTER\s+TABLE\b.*\bADD\s+(?:UNIQUE\s+)?INDEX\b/i,
      level: "warning",
      message: "ALTER TABLE ADD INDEX locks the table in older MySQL versions",
      suggestion: "Use pt-online-schema-change or gh-ost for large tables",
    },
    {
      id: "MG006",
      pattern: /\bLOCK\s+TABLES?\b/i,
      level: "error",
      message: "Explicit table lock detected",
      suggestion: "Avoid explicit locks",
    },
    {
      id: "MG007",
      pattern: /\bTRUNCATE\b/i,
      level: "error",
      message: "TRUNCATE deletes all rows",
      suggestion: "Use DELETE if partial removal is intended",
    },
  ],
  sqlite: [
    {
      id: "MG001",
      pattern: /\bDROP\s+TABLE\b/i,
      level: "error",
      message: "DROP TABLE permanently deletes data",
      suggestion: "Rename first",
    },
    {
      id: "MG002",
      pattern: /\bALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN\b/i,
      level: "error",
      message: "DROP COLUMN causes data loss (SQLite 3.35+)",
      suggestion: "Table rebuild approach for older SQLite versions",
    },
  ],
};

function analyzeMigration(filePath, content, dbType) {
  const findings = [];
  const patterns = DANGEROUS_PATTERNS[dbType] || DANGEROUS_PATTERNS.postgres;
  const lines = content.split("\n");

  for (const rule of patterns) {
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) {
        findings.push({
          file: filePath,
          line: i + 1,
          rule: rule.id,
          level: rule.level,
          message: rule.message,
          suggestion: rule.suggestion,
          code: lines[i].trim(),
        });
      }
    }
  }

  return findings;
}

function findMigrationFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMigrationFiles(fullPath));
    } else if (/\.(sql|rb|py|ts|js)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractSQL(content, ext) {
  if (ext === ".sql") return content;
  // Extract SQL from ORM migration files (Rails, Django, etc.)
  const sqlStrings = [];
  const patterns = [
    /execute\s*\(\s*["'`]([\s\S]*?)["'`]\s*\)/g,
    /sql\s*=\s*["'`]([\s\S]*?)["'`]/g,
    /raw_sql\s*=\s*["'`]([\s\S]*?)["'`]/g,
    /RunSQL\s*\(\s*["'`]([\s\S]*?)["'`]/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      sqlStrings.push(match[1]);
    }
  }
  // Also return original for pattern matching
  return content + "\n" + sqlStrings.join("\n");
}

async function run() {
  const migrationsDir = core.getInput("migrations-dir");
  const dbType = core.getInput("database-type");
  const failOnWarnings = core.getInput("fail-on-warnings") === "true";
  const failOnErrors = core.getInput("fail-on-errors") === "true";

  const migrationPath = path.resolve(migrationsDir);
  const files = findMigrationFiles(migrationPath);

  if (files.length === 0) {
    core.info(`No migration files found in ${migrationPath}`);
    return;
  }

  core.info(`Found ${files.length} migration file(s) in ${migrationPath}`);

  let allFindings = [];
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const ext = path.extname(file);
    const sql = extractSQL(content, ext);
    const findings = analyzeMigration(
      path.relative(process.cwd(), file),
      sql,
      dbType,
    );
    allFindings.push(...findings);
  }

  const errors = allFindings.filter((f) => f.level === "error");
  const warnings = allFindings.filter((f) => f.level === "warning");

  core.setOutput("errors-count", errors.length.toString());
  core.setOutput("warnings-count", warnings.length.toString());
  core.setOutput("report", JSON.stringify(allFindings));

  // Generate summary
  core.summary.addHeading("🗄️ Migration Guard Report", 2);
  core.summary.addRaw(
    `Analyzed **${files.length}** migration files for **${dbType}**\n\n`,
  );

  if (allFindings.length === 0) {
    core.summary.addRaw("✅ No dangerous operations detected!\n");
  } else {
    core.summary.addTable([
      [
        { data: "Level", header: true },
        { data: "Count", header: true },
      ],
      ["🔴 Error", errors.length.toString()],
      ["🟡 Warning", warnings.length.toString()],
    ]);

    for (const finding of allFindings) {
      const icon = finding.level === "error" ? "🔴" : "🟡";
      core.summary.addRaw(
        `${icon} **[${finding.rule}]** ${finding.message}\n` +
          `  - File: \`${finding.file}:${finding.line}\`\n` +
          `  - Code: \`${finding.code}\`\n` +
          `  - 💡 ${finding.suggestion}\n\n`,
      );
    }
  }

  await core.summary.write();

  if (failOnErrors && errors.length > 0) {
    core.setFailed(`Found ${errors.length} dangerous migration operation(s)`);
  } else if (failOnWarnings && warnings.length > 0) {
    core.setFailed(`Found ${warnings.length} migration warning(s)`);
  }
}

run().catch((error) => core.setFailed(error.message));
