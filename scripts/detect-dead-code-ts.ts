#!/usr/bin/env bun

/**
 * Script to detect dead code in TypeScript files using ts-prune and knip
 * Usage: bun scripts/detect-dead-code-ts.ts [--json] [--threshold=<number>]
 *
 * Options:
 *   --json           Output results in JSON format
 *   --threshold=N    Exit with error if more than N issues found (default: no limit)
 *   --output-dir=DIR Write reports to specified directory
 *
 * Exit codes:
 *   0 - Success (no dead code or below threshold)
 *   1 - Error running tools
 *   2 - Dead code found above threshold
 */

import { spawn } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

interface DeadCodeIssue {
  file: string;
  location: string;
  type: string;
  name: string;
  tool: "ts-prune" | "knip";
}

interface DeadCodeReport {
  timestamp: string;
  totalIssues: number;
  byTool: {
    tsPrune: number;
    knip: number;
  };
  byType: Record<string, number>;
  issues: DeadCodeIssue[];
  summary: {
    unusedExports: number;
    unusedFiles: number;
    unusedDependencies: number;
    other: number;
  };
}

interface CliOptions {
  json: boolean;
  threshold?: number;
  outputDir?: string;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    json: false
  };

  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--threshold=")) {
      options.threshold = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.split("=")[1];
    }
  }

  return options;
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      shell: true,
      cwd: process.cwd()
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", data => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", data => {
      stderr += data.toString();
    });

    proc.on("close", code => {
      // ts-prune and knip exit with non-zero when they find issues
      // We want to capture the output regardless
      if (code === 0 || stdout.length > 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", err => {
      reject(err);
    });
  });
}

function parseTsPruneOutput(output: string): DeadCodeIssue[] {
  const issues: DeadCodeIssue[] = [];
  const lines = output.split("\n").filter(line => line.trim());

  for (const line of lines) {
    // ts-prune format: src/file.ts:123 - exportName (used in module)
    const match = line.match(/^(.+?):(\d+)\s*-\s*(.+?)(?:\s*\(.*\))?$/);
    if (match) {
      const [, file, lineNum, name] = match;
      issues.push({
        file: file.trim(),
        location: `${file.trim()}:${lineNum}`,
        type: "unused export",
        name: name.trim(),
        tool: "ts-prune"
      });
    }
  }

  return issues;
}

function parseKnipOutput(output: string): DeadCodeIssue[] {
  const issues: DeadCodeIssue[] = [];

  try {
    const result = JSON.parse(output);

    // Parse unused files
    if (result.files) {
      for (const file of result.files) {
        issues.push({
          file,
          location: file,
          type: "unused file",
          name: path.basename(file),
          tool: "knip"
        });
      }
    }

    // Parse unused exports
    if (result.exports) {
      for (const [file, exports] of Object.entries(result.exports)) {
        for (const exp of exports as string[]) {
          issues.push({
            file,
            location: file,
            type: "unused export",
            name: exp,
            tool: "knip"
          });
        }
      }
    }

    // Parse unused dependencies
    if (result.dependencies) {
      for (const dep of result.dependencies) {
        issues.push({
          file: "package.json",
          location: "package.json",
          type: "unused dependency",
          name: dep,
          tool: "knip"
        });
      }
    }

    // Parse unused devDependencies
    if (result.devDependencies) {
      for (const dep of result.devDependencies) {
        issues.push({
          file: "package.json",
          location: "package.json",
          type: "unused devDependency",
          name: dep,
          tool: "knip"
        });
      }
    }
  } catch (error) {
    console.error("Failed to parse knip JSON output:", error);
  }

  return issues;
}

function generateReport(issues: DeadCodeIssue[]): DeadCodeReport {
  const byType: Record<string, number> = {};
  let tsPrune = 0;
  let knip = 0;

  for (const issue of issues) {
    byType[issue.type] = (byType[issue.type] || 0) + 1;
    if (issue.tool === "ts-prune") {
      tsPrune++;
    } else {
      knip++;
    }
  }

  return {
    timestamp: new Date().toISOString(),
    totalIssues: issues.length,
    byTool: {
      tsPrune,
      knip
    },
    byType,
    issues,
    summary: {
      unusedExports: (byType["unused export"] || 0),
      unusedFiles: (byType["unused file"] || 0),
      unusedDependencies: (byType["unused dependency"] || 0) + (byType["unused devDependency"] || 0),
      other: issues.length -
             (byType["unused export"] || 0) -
             (byType["unused file"] || 0) -
             (byType["unused dependency"] || 0) -
             (byType["unused devDependency"] || 0)
    }
  };
}

function printReport(report: DeadCodeReport, jsonOutput: boolean) {
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║       TypeScript Dead Code Detection Report              ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");

  console.log(`📅 Timestamp: ${report.timestamp}`);
  console.log(`📊 Total Issues: ${report.totalIssues}\n`);

  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│ Summary by Category                                     │");
  console.log("├─────────────────────────────────────────────────────────┤");
  console.log(`│ Unused Exports:       ${String(report.summary.unusedExports).padStart(4)} │`);
  console.log(`│ Unused Files:         ${String(report.summary.unusedFiles).padStart(4)} │`);
  console.log(`│ Unused Dependencies:  ${String(report.summary.unusedDependencies).padStart(4)} │`);
  console.log(`│ Other:                ${String(report.summary.other).padStart(4)} │`);
  console.log("└─────────────────────────────────────────────────────────┘\n");

  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│ Summary by Tool                                         │");
  console.log("├─────────────────────────────────────────────────────────┤");
  console.log(`│ ts-prune:             ${String(report.byTool.tsPrune).padStart(4)} │`);
  console.log(`│ knip:                 ${String(report.byTool.knip).padStart(4)} │`);
  console.log("└─────────────────────────────────────────────────────────┘\n");

  if (report.totalIssues > 0) {
    console.log("┌─────────────────────────────────────────────────────────┐");
    console.log("│ Issues Found                                            │");
    console.log("└─────────────────────────────────────────────────────────┘\n");

    const groupedByType: Record<string, DeadCodeIssue[]> = {};
    for (const issue of report.issues) {
      if (!groupedByType[issue.type]) {
        groupedByType[issue.type] = [];
      }
      groupedByType[issue.type].push(issue);
    }

    for (const [type, typeIssues] of Object.entries(groupedByType)) {
      console.log(`\n📍 ${type.toUpperCase()} (${typeIssues.length}):`);
      console.log("─".repeat(60));

      for (const issue of typeIssues.slice(0, 20)) {
        console.log(`  ${issue.location} - ${issue.name}`);
      }

      if (typeIssues.length > 20) {
        console.log(`  ... and ${typeIssues.length - 20} more`);
      }
    }
  }

  console.log("\n");
}

async function saveReports(report: DeadCodeReport, outputDir: string) {
  await mkdir(outputDir, { recursive: true });

  // Save JSON report
  const jsonPath = path.join(outputDir, "dead-code-report.json");
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  console.log(`📄 JSON report saved to: ${jsonPath}`);

  // Save markdown report
  const mdPath = path.join(outputDir, "dead-code-report.md");
  const markdown = generateMarkdownReport(report);
  await writeFile(mdPath, markdown);
  console.log(`📄 Markdown report saved to: ${mdPath}`);
}

function generateMarkdownReport(report: DeadCodeReport): string {
  let md = "# TypeScript Dead Code Detection Report\n\n";
  md += `**Timestamp:** ${report.timestamp}\n\n`;
  md += `**Total Issues:** ${report.totalIssues}\n\n`;

  md += "## Summary by Category\n\n";
  md += "| Category | Count |\n";
  md += "|----------|-------|\n";
  md += `| Unused Exports | ${report.summary.unusedExports} |\n`;
  md += `| Unused Files | ${report.summary.unusedFiles} |\n`;
  md += `| Unused Dependencies | ${report.summary.unusedDependencies} |\n`;
  md += `| Other | ${report.summary.other} |\n\n`;

  md += "## Summary by Tool\n\n";
  md += "| Tool | Count |\n";
  md += "|------|-------|\n";
  md += `| ts-prune | ${report.byTool.tsPrune} |\n`;
  md += `| knip | ${report.byTool.knip} |\n\n`;

  if (report.totalIssues > 0) {
    md += "## Issues Found\n\n";

    const groupedByType: Record<string, DeadCodeIssue[]> = {};
    for (const issue of report.issues) {
      if (!groupedByType[issue.type]) {
        groupedByType[issue.type] = [];
      }
      groupedByType[issue.type].push(issue);
    }

    for (const [type, typeIssues] of Object.entries(groupedByType)) {
      md += `### ${type.charAt(0).toUpperCase() + type.slice(1)} (${typeIssues.length})\n\n`;

      for (const issue of typeIssues) {
        md += `- \`${issue.location}\` - ${issue.name}\n`;
      }
      md += "\n";
    }
  }

  return md;
}

async function main() {
  const options = parseArgs();

  console.log("🔍 Running TypeScript dead code detection...\n");

  const allIssues: DeadCodeIssue[] = [];

  // Run ts-prune
  console.log("📦 Running ts-prune...");
  try {
    const tsPruneOutput = await runCommand("npx", ["ts-prune", "--error"]);
    const tsPruneIssues = parseTsPruneOutput(tsPruneOutput);
    allIssues.push(...tsPruneIssues);
    console.log(`   Found ${tsPruneIssues.length} issues\n`);
  } catch (error) {
    console.error("❌ ts-prune failed:", error);
    process.exit(1);
  }

  // Run knip
  console.log("🔪 Running knip...");
  try {
    const knipOutput = await runCommand("npx", ["knip", "--reporter", "json"]);
    const knipIssues = parseKnipOutput(knipOutput);
    allIssues.push(...knipIssues);
    console.log(`   Found ${knipIssues.length} issues\n`);
  } catch (error) {
    console.error("❌ knip failed:", error);
    process.exit(1);
  }

  // Generate report
  const report = generateReport(allIssues);

  // Print report
  printReport(report, options.json);

  // Save reports if output directory specified
  if (options.outputDir) {
    await saveReports(report, options.outputDir);
  }

  // Check threshold
  if (options.threshold !== undefined && report.totalIssues > options.threshold) {
    console.error(`\n❌ Dead code threshold exceeded: ${report.totalIssues} > ${options.threshold}`);
    process.exit(2);
  }

  if (report.totalIssues === 0) {
    console.log("✅ No dead code detected!");
    process.exit(0);
  } else if (options.threshold !== undefined && report.totalIssues <= options.threshold) {
    console.log(`✅ Found ${report.totalIssues} dead code issue(s), but within threshold of ${options.threshold}`);
    process.exit(0);
  } else {
    console.log(`⚠️  Found ${report.totalIssues} dead code issue(s)`);
    process.exit(2);
  }
}

main();
