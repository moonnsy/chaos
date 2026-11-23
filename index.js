import { mountComposer } from './composer.js';

const key = 'plot_nudge';
const ctx = () => SillyTavern.getContext();
const modes = {
    random: ['🎲', 'Случайно', 'Любой из трёх типов события'],
    event: ['✦', 'Событие', 'Оживить текущую сцену', [
        'Введи небольшое внешнее событие, которое прерывает рутину и даёт повод действовать.',
        'Пусть персонаж заметит неожиданную деталь в окружении, на которую можно отреагировать прямо сейчас.',
        'Введи уместное сообщение, визит или просьбу от уже знакомого персонажа.',
    ]],
    plot: ['↗', 'Развитие сюжета', 'Сдвинуть зависшую линию', [
        'Продвинь начатую сюжетную линию конкретным действием и покажи его первое последствие.',
        'Верни ранее посеянную деталь и преврати её в зацепку для следующего шага.',
        'Раскрой новую информацию по открытому вопросу и покажи, как она меняет ближайший план персонажа.',
    ]],
    chaos: ['⚡', 'Хаос', 'Подкинуть неожиданный поворот', [
        'Сорви ближайший план внезапным осложнением с правдоподобной для этой истории причиной.',
        'Пусть два известных обстоятельства неожиданно столкнутся и создадут проблему прямо в кадре.',
        'Покажи неожиданное последствие недавнего решения, которое резко меняет ход сцены.',
    ]],
    time: ['◷', 'Таймскип', 'Начать сцену позже'],
    custom: ['✎', 'Свой пинок', 'Задать направление вручную'],
};
let dialog;
let composer;
let pending;
let active = false;
let appliedToReply;
let starting = false;
let turns = 0;
let userTurn = false;
let lastCue;
let status = '';

function settings() {
    const config = ctx().extensionSettings[key] ??= { enabled: true, auto: false, interval: 5, mode: 'random' };
    config.quickButtons ??= false;
    return config;
}

function pick(items) {
    return items[Math.floor(Math.random() * items.length)];
}

function nudge(mode, time = '', detail = '') {
    const kind = mode === 'random' ? pick(['event', 'plot', 'chaos']) : mode;
    const cue = modes[kind][3] && pick(modes[kind][3].filter(text => text !== lastCue));
    return {
        kind, cue,
        text: [
            'Режиссёрская заметка к следующему посту ролевой игры.',
            time && `Перенеси действие вперёд на указанный срок: ${time}. Открой пост уже в новой сцене, обозначь прошедшее время и сохрани последствия предыдущих событий.`,
            cue,
            detail && `Пожелание к сцене: ${detail}`,
            'Покажи изменение в самом посте и продолжай на языке и в стиле чата. Сохрани характер персонажей и установленные факты. Оставь действия, реплики и мысли персонажа пользователя за пользователем. Не цитируй и не обсуждай эту заметку.',
        ].filter(Boolean).join('\n'),
    };
}

function inject(text) {
    // SillyTavern IN_CHAT, depth 0, no World Info scan, SYSTEM role.
    ctx().setExtensionPrompt(key, text, 1, 0, false, 0);
}

function clear() {
    if (active) inject('');
    active = false;
    userTurn = false;
}

globalThis.plotNudgeIntercept = async function (_chat, _size, _abort, type) {
    if (!settings().enabled || active) return;
    const context = ctx();
    if (type === 'swipe') {
        const message = context.chat.at(-1);
        if (message && !message.is_user && !message.is_system && typeof message.plot_nudge === 'string' && message.plot_nudge) {
            inject(message.plot_nudge);
            active = true;
            update('Повторён пинок для этого поста.');
        }
        return;
    }
    if (!['normal', 'group_chat'].includes(type)) return;
    const chatId = context.getCurrentChatId();
    const queued = pending?.chatId === chatId ? pending : undefined;
    const auto = userTurn && settings().auto && turns >= settings().interval;
    userTurn = false;
    if (!queued && !auto) return;

    const action = queued?.action ?? nudge('random');
    inject(action.text);
    active = true;
    appliedToReply = { chatId, messageId: context.chat.length, text: action.text };
    lastCue = action.cue;
    pending = undefined;
    turns = 0;
    update(`Применён пинок · ${modes[action.kind][1]}`);
    if (starting && dialog?.open) dialog.close();
};

const field = name => dialog.querySelector(`[name="${name}"]`);
function update(message = status) {
    status = message;
    if (!dialog) return;
    const config = settings();
    dialog.querySelector('fieldset').disabled = !config.enabled;
    field('enabled').checked = config.enabled;
    field('quickButtons').checked = config.quickButtons;
    if (composer) composer.hidden = !config.quickButtons;
    field('auto').checked = config.auto;
    field('interval').disabled = !config.auto;
    field('interval').value = config.interval;
    dialog.querySelector(`[name="mode"][value="${config.mode}"]`).checked = true;
    dialog.querySelector('[data-time]').hidden = config.mode === 'custom';
    dialog.querySelector('[data-cancel]').hidden = !pending;
    dialog.querySelector('[data-now]').disabled = starting;
    dialog.querySelector('[data-status]').textContent = !config.enabled ? 'Пинки выключены'
        : pending ? `В очереди · ${modes[pending.action.kind][1]}${status ? ' · ' + status : ''}` : status;
}

function reset() {
    clear();
    appliedToReply = undefined;
    pending = undefined;
    turns = 0;
    lastCue = undefined;
    if (dialog) {
        field('time').value = '';
        field('detail').value = '';
    }
    update('');
}

async function apply(now) {
    const config = settings();
    if (!config.enabled || starting) return;
    const chatId = ctx().getCurrentChatId();
    if (chatId == null || chatId === '') return update('Сначала открой чат с персонажем.');
    const time = config.mode === 'custom' ? '' : field('time').value.trim();
    const detail = field('detail').value.trim();
    if (config.mode === 'time' && !time) {
        field('time').focus();
        return update('Укажи, сколько времени должно пройти.');
    }
    if (config.mode === 'custom' && !detail) {
        field('detail').focus();
        return update('Напиши, что должно случиться.');
    }
    if (now && (active || document.querySelector('#mes_stop')?.getClientRects().length)) {
        return update('Дождись конца текущего ответа.');
    }
    if (now && document.querySelector('#send_textarea')?.value.trim()) {
        return update('Есть черновик. Выбери «На следующий ответ» и отправь свою реплику.');
    }

    const request = { chatId, action: nudge(config.mode, time, detail) };
    pending = request;
    update('');
    if (!now) return;

    starting = true;
    update();
    try {
        // Let Tavern select the current character or run the normal group round.
        await ctx().executeSlashCommandsWithOptions('/trigger await=true');
        if (pending === request) update('Ответ не запустился.');
    } catch (error) {
        console.error('[Сюжетный пинок]', error);
        update('Не удалось запустить ответ.');
    } finally {
        starting = false;
        update();
    }
}

function mount() {
    const menu = document.querySelector('#extensionsMenu');
    if (!menu || dialog) return;
    const entry = document.createElement('div');
    entry.className = 'extension_container';
    entry.innerHTML = '<div class="list-group-item flex-container flexGap5 interactable" role="button" tabindex="0"><i class="fa-solid fa-dice-d20 fa-fw" aria-hidden="true"></i><span>Сюжетный пинок</span></div>';
    menu.append(entry);
    composer = mountComposer(ctx, () => settings().quickButtons, () => settings().writerProfile ?? '');

    dialog = document.createElement('dialog');
    dialog.id = 'plot-nudge';
    dialog.setAttribute('aria-labelledby', 'plot-nudge-title');
    dialog.innerHTML = `
        <header><h2 id="plot-nudge-title">Сюжетный пинок</h2><button data-close aria-label="Закрыть">×</button></header>
        <label class="pn-toggle">Включить пинки <input type="checkbox" name="enabled" role="switch"></label>
        <label class="pn-toggle">Быстрые кнопки над полем ввода <input type="checkbox" name="quickButtons" role="switch"></label>
        <label class="pn-field pn-profile">Подключение для пера <select name="writerProfile"></select></label>
        <fieldset>
            <legend>Что произойдёт?</legend>
            <div class="pn-modes">${Object.entries(modes).map(([id, [, title, description]]) => `
                <label class="pn-mode" title="${description}">
                    <input type="radio" name="mode" value="${id}"><span>${title}</span>
                </label>`).join('')}</div>
            <label class="pn-field" data-time>Таймскип <input type="text" name="time" maxlength="120" placeholder="Например, три часа или до утра"></label>
            <label class="pn-field">Пожелание к сцене <textarea name="detail" rows="2" maxlength="800" placeholder="Например, пусть кто-то постучит в дверь"></textarea></label>
            <div class="pn-auto">
                <label><input type="checkbox" name="auto"> Автопинки</label>
                <label>Раз в <input type="number" name="interval" min="1" max="50"> твоих ходов</label>
            </div>
            <div class="pn-actions"><button data-next>На следующий ответ</button><button data-now>Пнуть сейчас</button></div>
        </fieldset>
        <footer><span data-status role="status"></span><button data-cancel hidden>Отменить пинок</button></footer>`;
    document.body.append(dialog);
    const open = () => {
        if (dialog.open) return;
        const select = field('writerProfile');
        const selected = settings().writerProfile ?? '';
        const profiles = ctx().extensionSettings.connectionManager?.profiles ?? [];
        select.replaceChildren(new Option('Текущее подключение SillyTavern', ''),
            ...profiles.map(profile => new Option(profile.name, profile.id)));
        if (selected && !profiles.some(profile => profile.id === selected)) {
            select.add(new Option('Сохранённый профиль недоступен', selected));
        }
        select.value = selected;
        update();
        dialog.showModal();
    };
    entry.addEventListener('click', open);
    entry.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        open();
    });
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.querySelector('[data-next]').onclick = () => apply(false);
    dialog.querySelector('[data-now]').onclick = () => apply(true);
    dialog.querySelector('[data-cancel]').onclick = () => {
        pending = undefined;
        update('Пинок отменён.');
    };
    dialog.addEventListener('change', ({ target }) => {
        const config = settings();
        if (target.name !== 'writerProfile' && !Object.hasOwn(config, target.name)) return;
        config[target.name] = target.type === 'checkbox' ? target.checked
            : target.type === 'number' ? Math.min(50, Math.max(1, Math.round(Number(target.value) || 5)))
                : target.value;
        if (target.name === 'enabled' && !config.enabled) reset();
        if (target.name === 'auto') {
            turns = 0;
            userTurn = false;
        }
        ctx().saveSettingsDebounced();
        update('');
    });
    const { eventSource, event_types: events } = ctx();
    eventSource.on(events.GENERATION_STARTED, (_type, _options, dryRun) => {
        if (!dryRun) appliedToReply = undefined;
    });
    eventSource.on(events.MESSAGE_RECEIVED, (messageId, type) => {
        if (!appliedToReply || !['normal', 'group_chat'].includes(type)) return;
        const context = ctx();
        if (appliedToReply.chatId !== context.getCurrentChatId() || appliedToReply.messageId !== messageId) return;
        const message = context.chat[messageId];
        if (!message || message.is_user || message.is_system) return;
        // Message-level data survives switching swipes, which replaces message.extra.
        message.plot_nudge = appliedToReply.text;
        appliedToReply = undefined;
    });
    eventSource.on(events.MESSAGE_SENT, () => {
        if (!settings().enabled || !settings().auto) return;
        turns++;
        userTurn = true;
    });
    eventSource.on(events.CHAT_CHANGED, reset);
    eventSource.on(events.GENERATION_ENDED, clear);
    eventSource.on(events.GENERATION_STOPPED, clear);
}

export function activate() {
    if (document.querySelector('#extensionsMenu')) mount();
    else {
        const { eventSource, event_types } = ctx();
        eventSource.on(event_types.APP_READY, mount);
    }
}

globalThis.jQuery(activate);
