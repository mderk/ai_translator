const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

// Default API endpoint
const DEFAULT_API_ENDPOINT = "http://localhost:1188";
const MAX_RETRIES = 10;
const RETRY_DELAYS = {
    429: 5000, // Rate limit - wait 5 seconds
    500: 10000, // Server error - wait 10 seconds
    400: 3000, // Bad request - wait 3 seconds
};

// Global state to track current progress
let currentState = {
    records: null,
    config: null,
    currentLang: null,
    progress: null,
    progressPath: null,
    csvPath: null,
};

// Placeholder handling
const PLACEHOLDER_PREFIX = "!!!!<";
const PLACEHOLDER_SUFFIX = ">!!!!";
const PLACEHOLDER_REGEX = /\{([^}]+)\}/g;

// Function to replace placeholders with special markers
function maskPlaceholders(text) {
    const placeholders = [];
    const maskedText = text.replace(PLACEHOLDER_REGEX, (match, param) => {
        placeholders.push(param);
        return `${PLACEHOLDER_PREFIX}${param}${PLACEHOLDER_SUFFIX}`;
    });
    return { maskedText, placeholders };
}

// Function to restore placeholders from special markers
function unmaskPlaceholders(text) {
    return text.replace(
        new RegExp(`${PLACEHOLDER_PREFIX}([^>]+)${PLACEHOLDER_SUFFIX}`, "g"),
        "{$1}"
    );
}

// Sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Get retry delay based on error status
function getRetryDelay(status) {
    return RETRY_DELAYS[status] || 5000; // Default to 5 seconds
}

// Translate text using DeepLX API with retries
async function translateText(
    text,
    sourceLang,
    targetLang,
    apiEndpoint,
    retryCount = 0
) {
    try {
        // Mask placeholders before translation
        const { maskedText, placeholders } = maskPlaceholders(text);

        if (placeholders.length > 0) {
            console.log(`Found placeholders: ${placeholders.join(", ")}`);
        }

        const response = await axios.post(`${apiEndpoint}/translate`, {
            text: maskedText,
            source_lang: sourceLang.toUpperCase(),
            target_lang: targetLang.toUpperCase(),
        });

        // Unmask placeholders in the translated text
        const translatedText = unmaskPlaceholders(response.data.data);
        return translatedText;
    } catch (error) {
        const status = error.response?.status || 500;
        const delay = getRetryDelay(status);

        if (retryCount >= MAX_RETRIES) {
            console.error(
                `\nFailed to translate after ${MAX_RETRIES} retries. Last error:`,
                error.message
            );
            throw error;
        }

        console.log(`\nTranslation error (${status}): ${error.message}`);
        console.log(
            `Retry ${retryCount + 1}/${MAX_RETRIES} in ${
                delay / 1000
            } seconds...`
        );

        await sleep(delay);
        return translateText(
            text,
            sourceLang,
            targetLang,
            apiEndpoint,
            retryCount + 1
        );
    }
}

async function loadProgressFile(progressFilePath) {
    try {
        if (await fs.pathExists(progressFilePath)) {
            const content = await fs.readJson(progressFilePath);
            return content;
        }
        return {};
    } catch (error) {
        console.error(
            `Error loading progress file ${progressFilePath}:`,
            error
        );
        return {};
    }
}

async function saveProgressFile(progressFilePath, progress) {
    try {
        await fs.writeJson(progressFilePath, progress, { spaces: 2 });
    } catch (error) {
        console.error(`Error saving progress file ${progressFilePath}:`, error);
    }
}

async function saveCurrentProgress() {
    if (
        !currentState.records ||
        !currentState.config ||
        !currentState.csvPath
    ) {
        return;
    }

    try {
        // Save progress file if available
        if (currentState.progress && currentState.progressPath) {
            await saveProgressFile(
                currentState.progressPath,
                currentState.progress
            );
        }

        // Save CSV
        const csvOutput = currentState.records.map((record) => {
            const row = {};
            row[currentState.config.keyColumn] =
                record[currentState.config.keyColumn];
            for (const lang of currentState.config.languages) {
                row[lang] = record[lang] || "";
            }
            return row;
        });

        const stringify = require("csv-stringify/sync").stringify;
        const outputCsv = stringify(csvOutput, { header: true });
        await fs.writeFile(currentState.csvPath, outputCsv);

        console.log("Progress and CSV saved successfully");
    } catch (error) {
        console.error("Error saving progress:", error);
    }
}

async function translateProject() {
    const argv = yargs(hideBin(process.argv))
        .usage("Usage: $0 [project] [lang] [options]")
        .option("project", {
            alias: "p",
            description: "Project name",
            type: "string",
        })
        .option("lang", {
            alias: "l",
            description: "Target language code (optional)",
            type: "string",
        })
        .option("api", {
            alias: "a",
            description: "API endpoint",
            type: "string",
            default: DEFAULT_API_ENDPOINT,
        })
        .help()
        .alias("help", "h")
        .example("$0 myproject fr", "Translate myproject to French")
        .example("$0 myproject", "Translate myproject to all languages")
        .example("$0 -p myproject -l fr", "Same using named arguments")
        .parse();

    // Handle positional arguments
    const [projectArg, langArg] = argv._;
    const projectName = argv.project || projectArg;
    const targetLang = argv.lang || langArg;

    if (!projectName) {
        console.error("Project name is required");
        process.exit(1);
    }

    try {
        // Load project configuration
        const projectDir = path.join(
            process.cwd(),
            "data",
            "projects",
            projectName
        );
        const configPath = path.join(projectDir, "config.json");

        if (!(await fs.pathExists(configPath))) {
            console.error(`Project "${projectName}" not found`);
            process.exit(1);
        }

        currentState.config = await fs.readJson(configPath);
        currentState.csvPath = path.join(
            projectDir,
            currentState.config.sourceFile
        );
        const csvContent = await fs.readFile(currentState.csvPath, "utf-8");
        currentState.records = parse(csvContent, {
            columns: true,
            skip_empty_lines: true,
        });

        // Determine which languages to process
        const targetLanguages = targetLang
            ? [targetLang]
            : currentState.config.languages.filter(
                  (lang) => lang !== currentState.config.baseLanguage
              );

        // Validate target languages
        for (const lang of targetLanguages) {
            if (!currentState.config.languages.includes(lang)) {
                console.error(
                    `Language "${lang}" is not defined in project configuration`
                );
                process.exit(1);
            }
        }

        // Process each target language
        for (const lang of targetLanguages) {
            console.log(`\nProcessing language: ${lang}`);
            currentState.currentLang = lang;

            // Ensure language directory exists
            const langDir = path.join(projectDir, lang);
            await fs.ensureDir(langDir);

            // Load or create progress file
            currentState.progressPath = path.join(langDir, "progress.json");
            currentState.progress = await loadProgressFile(
                currentState.progressPath
            );

            // Process each record
            for (const record of currentState.records) {
                if (record[lang]) {
                    continue;
                }
                const sourceText = record[currentState.config.baseLanguage];

                if (!currentState.progress[sourceText]) {
                    console.log(`\nTranslating: ${sourceText}`);
                    try {
                        const translation = await translateText(
                            sourceText,
                            currentState.config.baseLanguage,
                            lang,
                            argv.api
                        );
                        currentState.progress[sourceText] = translation;
                        record[lang] = translation;

                        // Save progress after each successful translation
                        await saveProgressFile(
                            currentState.progressPath,
                            currentState.progress
                        );

                        // Wait before next request
                        await sleep(1000);
                    } catch (error) {
                        console.error(
                            `Error translating text "${sourceText}":`,
                            error.message
                        );
                    }
                } else {
                    record[lang] = currentState.progress[sourceText];
                }
            }

            // Save progress for current language
            await saveCurrentProgress();
            console.log(`Completed translations for ${lang}`);
        }

        // Final save of all progress
        await saveCurrentProgress();
        console.log("\nTranslation process completed!");
    } catch (error) {
        console.error("Error during translation process:", error);
        await saveCurrentProgress();
        process.exit(1);
    }
}

// Handle script interruption
process.on("SIGINT", async () => {
    console.log("\nProcess interrupted. Saving progress...");
    await saveCurrentProgress();
    process.exit();
});

// Handle other termination signals
process.on("SIGTERM", async () => {
    console.log("\nProcess terminated. Saving progress...");
    await saveCurrentProgress();
    process.exit();
});

// Handle uncaught exceptions
process.on("uncaughtException", async (error) => {
    console.error("\nUncaught error:", error);
    await saveCurrentProgress();
    process.exit(1);
});

// Start processing
translateProject().catch(async (error) => {
    console.error("\nUnhandled error:", error);
    await saveCurrentProgress();
    process.exit(1);
});
