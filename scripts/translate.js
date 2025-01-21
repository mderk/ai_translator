const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const { parse } = require("csv-parse/sync");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

// Default API endpoint
const DEFAULT_API_ENDPOINT = "http://localhost:1188";
const MAX_RETRIES = 10;
const DEFAULT_DELAY = 700;
const PRO_DELAY = 300;
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

// Helper function to escape special characters in regex
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PLACEHOLDER_PREFIX = "🃟";
const PLACEHOLDER_SUFFIX = "🃟";
const CHAR_SEPARATOR = "❤️";
const PLACEHOLDER_REGEX = /\{([^}]+)\}/g;
const NEW_LINE_REPLACEMENT = "⏎";
const NEW_LINE_REGEX = /\\n|\n/g;

// Function to replace placeholders with special markers
function maskPlaceholders(text) {
    const placeholders = [];
    const maskedText = text.replace(PLACEHOLDER_REGEX, (match, param) => {
        placeholders.push(param);
        return `${PLACEHOLDER_PREFIX}${param
            .split("")
            .join(CHAR_SEPARATOR)}${PLACEHOLDER_SUFFIX}`;
    });
    return { maskedText, placeholders };
}

// Function to restore placeholders from special markers
function unmaskPlaceholders(text) {
    const escapedPrefix = escapeRegExp(PLACEHOLDER_PREFIX);
    const escapedSuffix = escapeRegExp(PLACEHOLDER_SUFFIX);
    return text.replace(
        new RegExp(
            `${escapedPrefix}([^${escapedPrefix}${escapedSuffix}]+)${escapedSuffix}`,
            "g"
        ),
        (match, param) => `{${param.split(CHAR_SEPARATOR).join("")}}`
    );
}

// Function to replace newlines with special markers
function replaceNewlines(text) {
    return text.replace(NEW_LINE_REGEX, ` ${NEW_LINE_REPLACEMENT} `);
}

// Function to restore newlines from special markers
function restoreNewlines(text) {
    return text.replace(
        new RegExp(`\\s*${NEW_LINE_REPLACEMENT}\\s*`, "g"),
        "\n"
    );
}

// Sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Get retry delay based on error status
function getRetryDelay(status) {
    return RETRY_DELAYS[status] || 5000; // Default to 5 seconds
}

async function wait(ms) {
    return await sleep(ms + Math.random() * 1000);
}

// Translate text using DeepLX API with retries
async function translateText(
    text,
    sourceLang,
    targetLang,
    apiEndpoint,
    pro = false,
    retryCount = 0
) {
    if (!text) {
        console.log("No text to translate");
        return text;
    }
    try {
        // Replace newlines with special markers
        //const textWithReplacedNewlines = replaceNewlines(text);

        // Mask placeholders before translation
        const { maskedText, placeholders } = maskPlaceholders(text);

        if (placeholders.length > 0) {
            console.log(`Found placeholders: ${placeholders.join(", ")}`);
        }

        const endpoint = pro ? "/v1/translate" : "/translate";
        console.log("Posting to", `${apiEndpoint}${endpoint}`);
        const response = await axios.post(`${apiEndpoint}${endpoint}`, {
            text: maskedText,
            source_lang: sourceLang.toUpperCase(),
            target_lang: targetLang.toUpperCase(),
        });

        // First restore newlines, then unmask placeholders
        //const restoredText = restoreNewlines(response.data.data);
        const translatedText = unmaskPlaceholders(response.data.data);
        //console.log(text, translatedText);
        console.log(`Got response (${response.data.data.length} characters):`);
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
        console.log(`Waiting for retry ${retryCount + 1}/${MAX_RETRIES}...`);

        await wait(delay);
        return translateText(
            text,
            sourceLang,
            targetLang,
            apiEndpoint,
            pro,
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
        console.log("No current state to save");
        return;
    }

    try {
        // Save progress file if available
        if (currentState.progress && currentState.progressPath) {
            await saveProgressFile(
                currentState.progressPath,
                currentState.progress
            );
            console.log(`Progress saved to ${currentState.progressPath}`);
        }

        // Update records with progress data
        if (currentState.currentLang) {
            for (const record of currentState.records) {
                const sourceText = record[currentState.config.baseLanguage];
                if (currentState.progress[sourceText]) {
                    record[currentState.currentLang] =
                        currentState.progress[sourceText];
                }
            }
        }

        // Save CSV with all current translations
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

        console.log(`Saving CSV to ${currentState.csvPath}`);
        console.log(`CSV contains ${csvOutput.length} records`);

        await fs.writeFile(currentState.csvPath, outputCsv);
        console.log("CSV file saved successfully");
    } catch (error) {
        console.error("Error saving progress:", error);
        throw error; // Re-throw to handle in the caller
    }
}

// Constants for batch processing
const MAX_BATCH_SIZE = 30;
const MAX_TEXT_LENGTH = 100;

// Function to check if text is suitable for batch processing
function isTextSuitableForBatch(text, maxTextLength) {
    return !text.includes("\n") && text.length <= maxTextLength;
}

// Function to process texts in batches
async function translateBatch(texts, sourceLang, targetLang, apiEndpoint) {
    // Join texts with newlines
    const batchText = texts.join("\n");

    // Use translateText for the batch
    const translatedBatch = await translateText(
        batchText,
        sourceLang,
        targetLang,
        apiEndpoint
    );

    // Split the result back into individual translations
    const translated = translatedBatch.split("\n");
    for (let i = 0; i < translated.length; i++) {
        try {
            translated[i] = translated[i].trim();
            if (
                texts[i][0] === texts[i][0].toUpperCase() &&
                translated[i][0] !== translated[i][0].toUpperCase()
            ) {
                translated[i] =
                    translated[i][0].toUpperCase() + translated[i].slice(1);
            }
        } catch (error) {
            console.error(`Error translating batch: ${error.message}`);
            console.error(
                "======================= Current text ========================"
            );
            console.error(texts[i]);
            console.error(translated[i]);
            console.error(
                "======================= Arrays ========================"
            );
            console.error(texts);
            console.error(translated);
            console.error(
                "======================= Batch text ========================"
            );
            console.error(batchText);
            console.error(translatedBatch);
            process.exit(1);
        }
    }
    return translated;
}

// Function to process all short texts in batches
async function processBatchTranslations(
    records,
    lang,
    apiEndpoint,
    pro,
    batchSize,
    batchMaxTextLength
) {
    console.log("\nProcessing short phrases in batches...");

    // Collect all untranslated short texts
    const shortTexts = [];
    const seenTexts = new Set();

    for (const record of records) {
        if (record[lang]) continue;

        const sourceText = record[currentState.config.baseLanguage];
        if (
            sourceText &&
            !currentState.progress[sourceText] &&
            isTextSuitableForBatch(sourceText, batchMaxTextLength) &&
            !seenTexts.has(sourceText) // Check for case-insensitive duplicates
        ) {
            shortTexts.push(sourceText);
            seenTexts.add(sourceText); // Add lowercase version to seen set
        }
    }

    if (shortTexts.length === 0) {
        console.log("No short phrases to process in batches.");
        return;
    }

    console.log(
        `Found ${shortTexts.length} unique short phrases for batch processing.`
    );

    // Process texts in batches
    for (let i = 0; i < shortTexts.length; i += batchSize) {
        const batch = shortTexts.slice(i, i + batchSize);
        console.log(
            `\nTranslating batch ${i / batchSize + 1} (${
                batch.length
            } phrases)...`
        );

        try {
            const translations = await translateBatch(
                batch,
                currentState.config.baseLanguage,
                lang,
                apiEndpoint
            );

            // Save translations
            for (let j = 0; j < batch.length; j++) {
                const sourceText = batch[j];
                const translation = translations[j];
                currentState.progress[sourceText] = translation;
            }

            // Save progress after each batch
            await saveProgressFile(
                currentState.progressPath,
                currentState.progress
            );

            // Wait before next batch
            await wait(pro ? PRO_DELAY : DEFAULT_DELAY);
        } catch (error) {
            console.error(`Error translating batch: ${error.message}`);
            process.exit(1);
        }
    }

    console.log("Batch processing completed.");
    await saveCurrentProgress();
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
        .option("pro", {
            description: "Use pro API endpoint",
            type: "boolean",
            default: false,
        })
        .option("skip-batch", {
            description: "Skip batch processing",
            type: "boolean",
            default: false,
        })
        .option("batch-size", {
            description: "Batch size",
            type: "number",
            default: MAX_BATCH_SIZE,
        })
        .option("batch-max-text-length", {
            description: "Max text length",
            type: "number",
            default: MAX_TEXT_LENGTH,
        })
        .option("rebuild", {
            description: "Rebuild translation based on progress files",
            type: "boolean",
            default: false,
        })
        .help()
        .alias("help", "h")
        .example("$0 myproject fr", "Translate myproject to French")
        .example("$0 myproject", "Translate myproject to all languages")
        .example("$0 -p myproject -l fr", "Same using named arguments")
        .parse();

    // Handle positional arguments
    const [projectArg, langArg] = argv._;
    const {
        project,
        lang,
        api,
        pro,
        skipBatch,
        batchSize,
        rebuild,
        batchMaxTextLength,
    } = argv;
    const projectName = project || projectArg;
    const targetLang = lang || langArg;

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

            if (rebuild) {
                for (const record of currentState.records) {
                    if (
                        !currentState.progress[
                            record[currentState.config.baseLanguage]
                        ]
                    ) {
                        record[lang] = null;
                    }
                }
            }

            if (!skipBatch) {
                // First pass: Process short phrases in batches
                await processBatchTranslations(
                    currentState.records,
                    lang,
                    api,
                    pro,
                    batchSize,
                    batchMaxTextLength
                );
            }

            // Second pass: Process remaining texts
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
                            api,
                            pro
                        );
                        currentState.progress[sourceText] = translation;
                        record[lang] = translation;

                        // Save progress after each successful translation
                        await saveProgressFile(
                            currentState.progressPath,
                            currentState.progress
                        );

                        // Wait before next request
                        await wait(pro ? PRO_DELAY : DEFAULT_DELAY);
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

// Add graceful shutdown helper
async function gracefulShutdown(exitCode = 0) {
    console.log("\nInitiating graceful shutdown...");
    try {
        // Force sync of current language progress if available
        if (currentState.currentLang && currentState.progress) {
            console.log(`Syncing progress for ${currentState.currentLang}`);
            for (const record of currentState.records) {
                const sourceText = record[currentState.config.baseLanguage];
                if (currentState.progress[sourceText]) {
                    record[currentState.currentLang] =
                        currentState.progress[sourceText];
                }
            }
        }

        await saveCurrentProgress();
        console.log("All progress saved successfully.");
        // Give more time for file operations to complete
        await new Promise((resolve) => setTimeout(resolve, 2000));
        process.exit(exitCode);
    } catch (error) {
        console.error("Error during graceful shutdown:", error);
        // Force exit after error
        await new Promise((resolve) => setTimeout(resolve, 2000));
        process.exit(1);
    }
}

// Handle script interruption
process.on("SIGINT", () => {
    console.log("\nProcess interrupted.");
    gracefulShutdown(0);
});

// Handle other termination signals
process.on("SIGTERM", () => {
    console.log("\nProcess terminated.");
    gracefulShutdown(0);
});

// Handle uncaught exceptions
process.on("uncaughtException", async (error) => {
    console.error("\nUncaught error:", error);
    gracefulShutdown(1);
});

// Start processing
translateProject().catch((error) => {
    console.error("\nUnhandled error:", error);
    gracefulShutdown(1);
});
