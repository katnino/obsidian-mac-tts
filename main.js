'use strict';

var obsidian = require('obsidian');
var child_process = require('child_process');
var path = require('path');
var os = require('os');

const DEFAULT_SETTINGS = {
    voice: 'Samantha',
    rate: 175
};

class MacTTSSettingTab extends obsidian.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Mac TTS Settings' });

        const result = child_process.spawnSync('say', ['-v', '?']);
        const voiceList = result.stdout
            ? result.stdout.toString().split('\n')
                .filter(l => l.trim().length > 0)
                .map(l => l.split(/\s+/)[0])
                .filter(v => v.length > 0)
            : ['Samantha'];

        new obsidian.Setting(containerEl)
            .setName('Voice')
            .setDesc('macOS voice to use for speech')
            .addDropdown(drop => {
                voiceList.forEach(v => drop.addOption(v, v));
                drop.setValue(this.plugin.settings.voice);
                drop.onChange(async (value) => {
                    this.plugin.settings.voice = value;
                    await this.plugin.saveSettings();
                });
            });

        new obsidian.Setting(containerEl)
            .setName('Speech rate')
            .setDesc('Words per minute (100 = slow, 175 = normal, 300 = fast)')
            .addSlider(slider => {
                slider
                    .setLimits(100, 400, 10)
                    .setValue(this.plugin.settings.rate)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.rate = value;
                        await this.plugin.saveSettings();
                    });
            });

        new obsidian.Setting(containerEl)
            .setName('Test voice')
            .setDesc('Preview current voice and rate settings')
            .addButton(btn => {
                btn.setButtonText('Test').onClick(() => {
                    child_process.spawn('say', [
                        '-v', this.plugin.settings.voice,
                        '-r', String(this.plugin.settings.rate),
                        'This is a test of the Mac TTS plugin.'
                    ]);
                });
            });
    }
}

class MacTTSPlugin extends obsidian.Plugin {
    constructor() {
        super(...arguments);
        this.currentProcess = null;
        this.isPlaying = false;
        this.isPaused = false;
    }

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new MacTTSSettingTab(this.app, this));

        this.addRibbonIcon('volume-2', 'Speak note / selection', () => this.speakSelection());
        this.addRibbonIcon('whole-word', 'Speak selected text only', () => {
            const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
            if (view && view.editor) {
                const sel = view.editor.getSelection();
                if (sel && sel.trim()) this.speak(sel);
                else new obsidian.Notice('No text selected');
            }
        });
        this.addRibbonIcon('circle-pause', 'Pause / Resume', () => this.togglePause());
        this.addRibbonIcon('square', 'Stop', () => this.stopPlayback());
        this.addRibbonIcon('download', 'Save as MP3', () => {
            const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
            if (view && view.editor) this.saveAudio(view.editor.getValue());
        });

        this.addCommand({
            id: 'speak-selection',
            name: 'Speak selected text',
            editorCallback: (editor) => {
                const sel = editor.getSelection();
                if (sel && sel.trim()) this.speak(sel);
                else new obsidian.Notice('No text selected');
            }
        });

        this.addCommand({
            id: 'speak-note',
            name: 'Speak entire note',
            editorCallback: (editor) => this.speakQueued(editor.getValue())
        });

        this.addCommand({
            id: 'pause-resume',
            name: 'Pause / Resume playback',
            callback: () => this.togglePause()
        });

        this.addCommand({
            id: 'stop-playback',
            name: 'Stop playback',
            callback: () => this.stopPlayback()
        });

        this.addCommand({
            id: 'save-audio',
            name: 'Save note as MP3',
            editorCallback: (editor) => this.saveAudio(editor.getValue())
        });

        this.addCommand({
            id: 'save-selection-audio',
            name: 'Save selected text as MP3',
            editorCallback: (editor) => {
                const sel = editor.getSelection();
                if (sel && sel.trim()) this.saveAudio(sel);
                else new obsidian.Notice('No text selected');
            }
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    getSayArgs(text) {
        return ['-v', this.settings.voice, '-r', String(this.settings.rate), text.trim()];
    }

    togglePause() {
        if (!this.currentProcess || !this.isPlaying) {
            new obsidian.Notice('Nothing is playing');
            return;
        }
        if (this.isPaused) {
            this.currentProcess.kill('SIGCONT');
            this.isPaused = false;
            new obsidian.Notice('Resumed');
        } else {
            this.currentProcess.kill('SIGSTOP');
            this.isPaused = true;
            new obsidian.Notice('Paused');
        }
    }

    stopPlayback() {
        this.isPlaying = false;
        this.isPaused = false;
        if (this.currentProcess) {
            this.currentProcess.kill('SIGKILL');
            this.currentProcess = null;
        }
        new obsidian.Notice('Stopped');
    }

    speak(text) {
        if (!text || !text.trim()) {
            new obsidian.Notice('No text to speak');
            return;
        }
        this.stopPlayback();
        this.isPlaying = true;
        this.isPaused = false;

        const proc = child_process.spawn('say', this.getSayArgs(text));
        this.currentProcess = proc;

        proc.on('close', () => { this.currentProcess = null; this.isPlaying = false; });
        proc.on('error', (e) => { new obsidian.Notice('TTS Error: ' + e.message); this.isPlaying = false; });
    }

    async speakQueued(text) {
        if (!text || !text.trim()) { new obsidian.Notice('No text to speak'); return; }
        this.stopPlayback();
        this.isPlaying = true;
        this.isPaused = false;

        const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
        new obsidian.Notice('Speaking ' + paragraphs.length + ' paragraph(s)...');

        for (let i = 0; i < paragraphs.length; i++) {
            if (!this.isPlaying) break;
            await this.speakAndWait(paragraphs[i]);
        }

        if (this.isPlaying) { this.isPlaying = false; new obsidian.Notice('Playback complete'); }
    }

    speakAndWait(text) {
        return new Promise((resolve) => {
            if (!this.isPlaying) { resolve(); return; }
            const proc = child_process.spawn('say', this.getSayArgs(text));
            this.currentProcess = proc;
            proc.on('close', () => { this.currentProcess = null; resolve(); });
            proc.on('error', (e) => { new obsidian.Notice('TTS Error: ' + e.message); this.currentProcess = null; resolve(); });
        });
    }

    saveAudio(text) {
        if (!text || !text.trim()) { new obsidian.Notice('No text to save'); return; }

        const activeFile = this.app.workspace.getActiveFile();
        const baseName = activeFile ? activeFile.basename : 'tts-output';
        const downloadsPath = path.join(os.homedir(), 'Downloads');
        const aiffPath = path.join(downloadsPath, baseName + '.aiff');
        const mp3Path = path.join(downloadsPath, baseName + '.mp3');

        new obsidian.Notice('Saving audio to Downloads...');

        const args = ['-v', this.settings.voice, '-r', String(this.settings.rate), '-o', aiffPath, text.trim()];
        const proc = child_process.spawn('say', args);

        proc.on('close', (code) => {
            if (code !== 0) { new obsidian.Notice('Save failed: say command error'); return; }
            const convert = child_process.spawn('afconvert', ['-f', 'mp4f', '-d', 'aac', aiffPath, mp3Path]);
            convert.on('close', (c) => {
                child_process.spawn('rm', [aiffPath]);
                if (c === 0) new obsidian.Notice('Saved to Downloads: ' + baseName + '.mp3');
                else new obsidian.Notice('Saved to Downloads: ' + baseName + '.aiff');
            });
            convert.on('error', () => new obsidian.Notice('Saved to Downloads: ' + baseName + '.aiff'));
        });

        proc.on('error', (e) => new obsidian.Notice('Save failed: ' + e.message));
    }

    speakSelection() {
        const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
        if (view && view.editor) {
            const sel = view.editor.getSelection();
            if (sel && sel.trim()) this.speak(sel);
            else this.speakQueued(view.editor.getValue());
        }
    }

    onunload() { this.stopPlayback(); }
}

module.exports = MacTTSPlugin;
