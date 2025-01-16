const fs = require("fs-extra");
const path = require("path");
const { parse } = require("csv-parse/sync");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

async function createProject() {
    const argv = yargs(hideBin(process.argv))
        .option("name", {
            alias: "n",
            description: "Project name",
            type: "string",
            demandOption: true,
        })
        .option("csv", {
            alias: "c",
            description: "Path to CSV file",
            type: "string",
            demandOption: true,
        })
        .option("base-lang", {
            alias: "b",
            description: "Base language code",
            type: "string",
            demandOption: true,
        })
        .option("key", {
            alias: "k",
            description: "Column name containing translation keys",
            type: "string",
            demandOption: true,
        })
        .help()
        .alias("help", "h")
        .example(
            "$0 -n myproject -c path/to/file.csv -b en -k translation_key",
            "Create new project with all required parameters"
        )
        .example(
            "$0 --name myproject --csv path/to/file.csv --base-lang en --key id",
            "Same using long option names"
        )
        .strict()
        .parse();

    const projectName = argv.name;
    const csvPath = argv.csv;
    const baseLang = argv["base-lang"];
    const keyColumn = argv.key;

    const projectsDir = path.join(process.cwd(), "data", "projects");
    const projectDir = path.join(projectsDir, projectName);

    // Ensure projects directory exists
    await fs.ensureDir(projectsDir);

    // Check if project already exists
    if (await fs.pathExists(projectDir)) {
        console.error(`Project "${projectName}" already exists`);
        process.exit(1);
    }

    // Read and parse CSV file
    try {
        // Resolve the CSV path relative to current working directory
        const resolvedCsvPath = path.resolve(process.cwd(), csvPath);
        console.log(`Trying to read CSV from: ${resolvedCsvPath}`);

        const csvContent = await fs.readFile(resolvedCsvPath, "utf-8");
        const records = parse(csvContent, {
            columns: true,
            skip_empty_lines: true,
        });

        // Validate key column exists
        if (!records[0].hasOwnProperty(keyColumn)) {
            console.error(`Key column "${keyColumn}" not found in CSV file`);
            console.error(
                `Available columns: ${Object.keys(records[0]).join(", ")}`
            );
            process.exit(1);
        }

        // Get language codes from CSV headers, excluding the key column
        const languages = Object.keys(records[0]).filter(
            (col) => col !== keyColumn
        );

        // Validate base language exists in CSV
        if (!languages.includes(baseLang)) {
            console.error(`Base language "${baseLang}" not found in CSV file`);
            console.error(`Available languages: ${languages.join(", ")}`);
            process.exit(1);
        }

        // Create project directory
        await fs.mkdir(projectDir);

        // Create config file
        const config = {
            name: projectName,
            sourceFile: path.basename(csvPath),
            languages: languages,
            baseLanguage: baseLang,
            keyColumn: keyColumn,
        };
        await fs.writeJson(path.join(projectDir, "config.json"), config, {
            spaces: 2,
        });

        // Create language directories
        for (const lang of languages) {
            await fs.mkdir(path.join(projectDir, lang));
        }

        // Copy CSV file to project directory
        await fs.copy(
            resolvedCsvPath,
            path.join(projectDir, path.basename(csvPath))
        );

        console.log(`Project "${projectName}" created successfully`);
        console.log(`Languages detected: ${languages.join(", ")}`);
        console.log(`Base language: ${baseLang}`);
        console.log(`Using "${keyColumn}" as translation key column`);
    } catch (error) {
        if (error.code === "ENOENT") {
            console.error(`CSV file not found: ${resolvedCsvPath}`);
        } else {
            console.error("Error creating project:", error.message);
        }
        process.exit(1);
    }
}

createProject().catch(console.error);
