// scripts/verify-job-runs-schema.ts
// Verifies job_runs.status column accepts 'success' and 'error'
//
// Run with: npx tsx scripts/verify-job-runs-schema.ts
// Requires: POSTGRES_URL env var (via .env or environment)

import { sql } from '@vercel/postgres';
import * as dotenv from 'dotenv';

// Load .env.local for local development
dotenv.config({ path: '.env.local' });

const REQUIRED_VALUES = ['success', 'error'] as const;
const TEXT_TYPES = ['text', 'character varying', 'bpchar'];

async function main(): Promise<void> {
  console.log('='.repeat(70));
  console.log('VERIFY: public.job_runs.status column schema');
  console.log('='.repeat(70));

  let columnType: string | null = null;
  let udtName: string | null = null;
  let enumValues: string[] = [];
  let checkConstraintValues: string[] = [];
  let tableExists = false;

  try {
    // =========================================================================
    // Step 1: Check if table exists and get column type
    // =========================================================================
    console.log('\n[1] Checking column data type in information_schema...\n');

    const columnInfo = await sql`
      SELECT data_type, udt_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'job_runs'
        AND column_name = 'status'
    `;

    if (columnInfo.rows.length === 0) {
      console.log('    WARN: public.job_runs.status column not found');
      console.log('    The table may not exist or migrations not run.\n');
    } else {
      tableExists = true;
      const row = columnInfo.rows[0];
      columnType = row.data_type;
      udtName = row.udt_name;

      console.log(`    data_type:   ${columnType}`);
      console.log(`    udt_name:    ${udtName}`);
      console.log(`    is_nullable: ${row.is_nullable}`);
    }

    // =========================================================================
    // Step 2: If custom type (enum), get allowed values
    // =========================================================================
    if (udtName && !TEXT_TYPES.includes(udtName)) {
      console.log('\n[2] Checking for enum type values...\n');

      const enumResult = await sql`
        SELECT e.enumlabel AS value
        FROM pg_type t
        JOIN pg_enum e ON t.oid = e.enumtypid
        JOIN pg_namespace n ON t.typnamespace = n.oid
        WHERE n.nspname = 'public'
          AND t.typname = ${udtName}
        ORDER BY e.enumsortorder
      `;

      if (enumResult.rows.length > 0) {
        enumValues = enumResult.rows.map(r => r.value);
        console.log(`    Enum type: ${udtName}`);
        console.log(`    Allowed values: ${JSON.stringify(enumValues)}`);
      } else {
        console.log('    (Not a public enum or no values found)');
      }
    } else {
      console.log('\n[2] Column is TEXT/VARCHAR - skipping enum check.');
    }

    // =========================================================================
    // Step 3: Check for CHECK constraints on status column
    // =========================================================================
    console.log('\n[3] Checking CHECK constraints on public.job_runs...\n');

    const constraintResult = await sql`
      SELECT conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_namespace n ON c.connamespace = n.oid
      WHERE n.nspname = 'public'
        AND c.conrelid = 'public.job_runs'::regclass
        AND c.contype = 'c'
    `;

    if (constraintResult.rows.length === 0) {
      console.log('    (No CHECK constraints found on public.job_runs)');
    } else {
      for (const row of constraintResult.rows) {
        console.log(`    Constraint: ${row.conname}`);
        console.log(`    Definition: ${row.definition}`);

        // Parse CHECK constraint for status column values
        // Example: CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'error'::text])))
        // Or: CHECK (status IN ('running', 'success', 'error'))
        const def = row.definition;
        if (def.toLowerCase().includes('status')) {
          // Extract quoted strings from constraint definition
          const matches = def.match(/'([^']+)'/g);
          if (matches) {
            const values = matches.map((m: string) => m.replace(/'/g, ''));
            checkConstraintValues.push(...values);
          }
        }
        console.log('');
      }

      // Dedupe checkConstraintValues
      checkConstraintValues = Array.from(new Set(checkConstraintValues));

      if (checkConstraintValues.length > 0) {
        console.log(`    Parsed status constraint values: ${JSON.stringify(checkConstraintValues)}`);
      }
    }

    // =========================================================================
    // Step 4: Determine allowed values and validate
    // =========================================================================
    console.log('\n[4] Compatibility analysis...\n');

    let allowedValues: string[] = [];
    let validationSource = '';
    const isTextType = columnType !== null && TEXT_TYPES.includes(columnType);

    if (enumValues.length > 0) {
      allowedValues = enumValues;
      validationSource = 'enum type';
    } else if (checkConstraintValues.length > 0) {
      allowedValues = checkConstraintValues;
      validationSource = 'CHECK constraint';
    }

    // Determine if values are allowed
    let successAllowed = false;
    let errorAllowed = false;
    let unrestricted = false;

    if (allowedValues.length > 0) {
      // Explicit constraints exist - check them
      successAllowed = allowedValues.includes('success');
      errorAllowed = allowedValues.includes('error');
      console.log(`    Validation source: ${validationSource}`);
      console.log(`    Allowed values:    ${JSON.stringify(allowedValues)}`);
    } else if (isTextType) {
      // TEXT column with no constraints - unrestricted
      unrestricted = true;
      successAllowed = true;
      errorAllowed = true;
      console.log('    Validation source: (none)');
      console.log('    TEXT column with no constraint - all string values accepted');
    } else if (!tableExists) {
      console.log('    Cannot validate - table does not exist');
    } else {
      // Unknown type with no constraints - cannot determine
      console.log('    Validation source: (unknown)');
      console.log(`    Column type '${columnType}' with no constraints found`);
    }

    console.log('');
    console.log(`    'success' allowed: ${successAllowed ? 'YES' : 'NO'}`);
    console.log(`    'error' allowed:   ${errorAllowed ? 'YES' : 'NO'}`);

    // =========================================================================
    // Step 5: Show recent job_runs (if table exists)
    // =========================================================================
    if (tableExists) {
      console.log('\n[5] Recent job_runs entries (sanity check)...\n');

      const recentRuns = await sql`
        SELECT job_name, status, started_at::text, finished_at::text
        FROM public.job_runs
        ORDER BY started_at DESC
        LIMIT 5
      `;

      if (recentRuns.rows.length > 0) {
        for (const row of recentRuns.rows) {
          const finished = row.finished_at ? row.finished_at.slice(0, 19) : '(running)';
          console.log(`    ${row.job_name.padEnd(20)} ${row.status.padEnd(10)} ${row.started_at?.slice(0, 19)} -> ${finished}`);
        }
      } else {
        console.log('    (No job_runs entries yet)');
      }
    }

    // =========================================================================
    // Final verdict
    // =========================================================================
    console.log('\n' + '='.repeat(70));

    if (!tableExists) {
      console.log('RESULT: INCONCLUSIVE - public.job_runs table not found');
      console.log('        Run migrations before using job_runs logging.');
      console.log('='.repeat(70));
      process.exit(1);
    }

    if (successAllowed && errorAllowed) {
      console.log('RESULT: PASS');
      console.log("        public.job_runs.status accepts 'success' and 'error'");
      if (unrestricted) {
        console.log('        (TEXT column, no constraint - unrestricted)');
      } else {
        console.log(`        Validated via: ${validationSource}`);
        console.log(`        Full allowed set: ${JSON.stringify(allowedValues)}`);
      }
      console.log('='.repeat(70));
      process.exit(0);
    } else if (allowedValues.length === 0 && !isTextType) {
      console.log('RESULT: INCONCLUSIVE');
      console.log(`        Column type '${columnType}' - cannot determine allowed values`);
      console.log('        No enum values or CHECK constraints found');
      console.log('='.repeat(70));
      process.exit(1);
    } else {
      console.log('RESULT: FAIL');
      console.log('        Required values NOT allowed by schema:');
      if (!successAllowed) console.log("          - 'success' is NOT allowed");
      if (!errorAllowed) console.log("          - 'error' is NOT allowed");
      console.log(`        Current allowed values: ${JSON.stringify(allowedValues)}`);
      console.log('='.repeat(70));
      process.exit(1);
    }

  } catch (err) {
    console.error('\n' + '='.repeat(70));
    console.error('RESULT: ERROR - Database query failed');
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
    console.error('='.repeat(70));
    process.exit(1);
  }
}

main();
