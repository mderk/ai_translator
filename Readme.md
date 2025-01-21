# Translation Project Manager

A tool for managing translation projects using DeepLX API.

## Features

-   Batch translation of short phrases for better performance
-   Progress tracking and resumable translations
-   Support for placeholders in text (e.g. {name}, {count})
-   Automatic case preservation
-   Graceful shutdown with progress saving
-   Support for both regular and Pro DeepLX API endpoints

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd translator
```

2. Install dependencies:

```bash
yarn install
```

3. Set up DeepLX:
    - Install and run DeepLX (https://deeplx.owo.network/) API server
    - By default, the translator expects the API to be running at `http://localhost:1188`
    - You can specify a different API endpoint using the `--api` option when translating

## Usage

```bash
node scripts/translate.js [project] [lang] [options]
```

### Arguments

-   `project`: Project name (required)
-   `lang`: Target language code (optional, if not specified all languages will be processed)

### Options

-   `-p, --project`: Project name (alternative to positional argument)
-   `-l, --lang`: Target language code (alternative to positional argument)
-   `-a, --api`: API endpoint (default: http://localhost:1188)
-   `--pro`: Use pro API endpoint (default: false)
-   `--skip-batch`: Skip batch processing of short phrases (default: false)
-   `--batch-size`: Number of phrases to process in one batch (default: 30)
-   `--batch-max-text-length`: Maximum text length for batch processing (default: 100)
-   `--rebuild`: Rebuild translations based on progress files (default: false)

### Examples

```bash
# Translate myproject to French
node scripts/translate.js myproject fr

# Translate myproject to all configured languages
node scripts/translate.js myproject

# Same using named arguments
node scripts/translate.js -p myproject -l fr

# Use custom API endpoint
node scripts/translate.js myproject fr -a http://my-deeplx-server:1188

# Use pro endpoint
node scripts/translate.js myproject fr --pro
```

## Project Structure

```
data/
  projects/
    myproject/
      config.json      # Project configuration
      translations.csv # Source file with translations
      fr/             # Language-specific directory
        progress.json # Translation progress for French
      de/
        progress.json # Translation progress for German
      ...
```

### Project Configuration (config.json)

```json
{
    "sourceFile": "translations.csv",
    "keyColumn": "key",
    "baseLanguage": "en",
    "languages": ["en", "fr", "de", "es", "it"]
}
```

### CSV Format

The CSV file should have columns for each language and a key column:

```csv
key,en,fr,de
welcome,"Welcome!","Bienvenue!","Willkommen!"
hello,"Hello {name}","Bonjour {name}","Hallo {name}"
```

## Features in Detail

### Batch Processing

Short phrases (less than 100 characters by default) are processed in batches for better performance. The tool automatically:

-   Groups suitable phrases together
-   Preserves original text case
-   Handles placeholders correctly
-   Saves progress after each batch

### Progress Tracking

-   Progress is saved after each translation
-   Interrupted translations can be resumed
-   Each language has its own progress file
-   CSV file is updated with all translations

### Graceful Shutdown

When the process is interrupted (Ctrl+C):

1. Current progress is saved
2. CSV file is updated
3. All file operations are completed before exit

### Error Handling

-   Automatic retries for API errors
-   Different retry delays based on error type
-   Progress is saved even on errors
-   Detailed error logging

## Commands

### start-project

Creates a new translation project with the specified name and CSV file.

#### Usage

```bash
yarn start-project --name <project-name> --csv <path-to-csv> --base-lang <language-code> --key <key-column>
# or using short options
yarn start-project -n <project-name> -c <path-to-csv> -b <language-code> -k <key-column>
```

#### Options

-   `--name`, `-n` (required): Name of the project to create
-   `--csv`, `-c` (required): Path to the CSV file containing translations
-   `--base-lang`, `-b` (required): Base language code
-   `--key`, `-k` (required): Column name containing translation keys

#### Examples

```bash
# Create a new project with all required parameters
yarn start-project --name myproject --csv path/to/translations.csv --base-lang en --key translation_id

# Same using short options
yarn start-project -n myproject -c path/to/translations.csv -b en -k identifier
```

#### What it does

1. Creates a new project directory under `data/projects/<project-name>`
2. Reads and validates the CSV file
3. Creates a `config.json` file with project settings (including name, source file, languages, base language, and key column)
4. Creates subdirectories for each language found in the CSV (excluding the key column)
5. Copies the source CSV file to the project directory

#### CSV File Format

The CSV file should have:

-   A column for translation keys (specified by --key parameter)
-   Language code columns for each supported language
-   Each row contains the translation key and corresponding translations

Example CSV format:

```csv
key,en,fr,es
welcome_message,Welcome,Bienvenue,Bienvenido
goodbye_message,Goodbye,Au revoir,Adiós
```

#### Error Handling

-   Exits with error if the project already exists
-   Exits with error if the CSV file is not found
-   Exits with error if there are issues parsing the CSV file
-   Exits with error if the specified key column is not found in the CSV file

### translate

Translates missing strings in a project using the DeepL API.

#### Usage

```bash
yarn translate <project-name> [language-code]
# or using named options
yarn translate --project <project-name> [--lang <language-code>] [--api <api-endpoint>]
```

#### Options

-   `project-name` (required): Name of the project to translate
-   `language-code` (optional): Specific language to translate. If omitted, translates all languages
-   `--api`, `-a` (optional): Custom API endpoint (defaults to http://localhost:1188)
-   `--pro`, `-p` (optional): Use pro API endpoint (defaults to false)

#### Examples

```bash
# Translate all missing strings for all languages in the project
yarn translate myproject

# Translate only Russian strings
yarn translate myproject ru

# Using named options with custom API endpoint
yarn translate --project myproject --lang fr --api http://custom-api:1188
```

#### What it does

1. Loads project configuration and CSV file
2. For each target language:
    - Creates a progress file in the language directory if it doesn't exist
    - Loads existing translations from the progress file
    - Translates missing strings using the base language as source
    - Saves progress after each successful translation
    - Updates the CSV file with new translations
3. Automatically saves progress and CSV file on interruption or error

#### Progress Tracking

-   Each language has its own progress file (`progress.json`) that tracks completed translations
-   Progress is saved after each successful translation
-   CSV file is updated regularly to reflect current progress
-   All progress is saved even if the process is interrupted (Ctrl+C) or encounters an error

#### Error Handling

-   Validates project existence and configuration
-   Validates language codes against project configuration
-   Retries failed translations up to 10 times with increasing delays
-   Saves progress and CSV on any type of interruption or error
