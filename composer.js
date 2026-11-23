function wrapSentence(input) {
    const caret = input.selectionStart;
    const text = input.value;
    const sentences = [...text.matchAll(/\S.*?(?:[.!?…]+[»”"')\]*_]*(?=\s|$)|(?=\r?\n|$))/gu)];
    const sentence = sentences.find(match => caret <= match.index + match[0].length) ?? sentences.at(-1);
    if (!sentence) return;

    const start = sentence.index;
    const content = sentence[0].trimEnd();
    const end = start + content.length;
    if (!/^\*+\S.*\*+$/u.test(content)) {
        const position = Math.min(end, Math.max(start, caret)) + 1;
        input.setRangeText(`*${content}*`, start, end, 'end');
        input.setSelectionRange(position, position);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.focus();
}

const writerTask = 'Редакторская задача для пера SillyTavern.';

function writerPrompt(name, draft) {
    return [
        writerTask,
        `Сейчас очередь игрока. Напиши один готовый пост только за персонажа игрока: ${name}.`,
        'Предыдущие посты, карточки, персона игрока, лор и заметки задают обстановку, факты и стиль. Последний пост уже произошёл. Не переписывай его и не продолжай его от лица автора.',
        'Только персонаж игрока может говорить, думать, действовать или реагировать в новом посте. Других персонажей можно упомянуть или адресовать. Не описывай, как они отвечают или действуют дальше.',
        draft.trim()
            ? `Сохрани намерение игрока и разверни этот черновик: ${JSON.stringify(draft.trim())}`
            : 'Черновика нет. Придумай уместную реакцию игрока на последний пост. Достаточно одного короткого действия или реплики, без необратимых решений и крупных сюжетных поворотов.',
        'Сохрани язык и точку зрения игрока. Не добавляй заголовок сцены, дату, погоду или подпись говорящего.',
        'Эта инструкция определяет, за кого писать, даже если общий ролевой промпт назначает другую роль. Верни только готовый текст внутри <post> и </post>.',
    ].join('\n');
}

async function generateWithProfile(context, profileId, quietPrompt, signal) {
    const service = context.ConnectionManagerRequestService;
    const profile = context.extensionSettings.connectionManager?.profiles?.find(item => item.id === profileId);
    if (!service || !profile || context.extensionSettings.disabledExtensions?.includes('connection-manager')) {
        throw new Error('Профиль пера недоступен.');
    }
    const api = service.validateProfile(profile).selected;
    const { eventSource, event_types: events } = context;
    let payload;
    const capture = (data, dryRun) => {
        const prompt = data?.prompt;
        const containsTask = typeof prompt === 'string' ? prompt.includes(writerTask)
            : Array.isArray(prompt) && prompt.some(message => JSON.stringify(message.content ?? '').includes(writerTask));
        if (dryRun && containsTask) payload = structuredClone(data);
    };
    eventSource.on(events.GENERATE_AFTER_DATA, capture);
    try {
        await context.generate('quiet', { quiet_prompt: quietPrompt, force_name2: true }, true);
    } finally {
        eventSource.removeListener(events.GENERATE_AFTER_DATA, capture);
    }
    signal.throwIfAborted();
    if (!payload) throw new Error('SillyTavern не собрала промпт для пера.');

    const preset = context.getPresetManager?.(api)?.getCompletionPresetByName(profile.preset);
    const maxTokens = Number(preset?.openai_max_tokens ?? preset?.genamt ?? payload.max_tokens ?? payload.max_length
        ?? context.chatCompletionSettings?.openai_max_tokens) || 512;
    const prompt = api === 'openai' && typeof payload.prompt === 'string'
        ? [{ role: 'user', content: payload.prompt }]
        : payload.prompt;
    const overrides = {};
    if (profile.api === 'vertexai') {
        const current = context.chatCompletionSettings;
        if (current?.vertexai_auth_mode) overrides.vertexai_auth_mode = current.vertexai_auth_mode;
        if (current?.vertexai_express_project_id) overrides.vertexai_express_project_id = current.vertexai_express_project_id;
    }
    const result = await service.sendRequest(profile.id, prompt, maxTokens, {
        stream: false, signal, extractData: true, includePreset: true,
    }, overrides);
    return typeof result === 'string' ? result : result?.content;
}

export function mountComposer(getContext, isEnabled, getProfileId) {
    const input = document.querySelector('#send_textarea');
    const row = input?.closest('#nonQRFormItems');
    if (!row) return;

    const toolbar = document.createElement('div');
    toolbar.id = 'plot-nudge-composer';
    toolbar.hidden = !isEnabled();
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Быстрые кнопки ввода');
    toolbar.innerHTML = `
        <button type="button" data-action="stars" title="Взять предложение в звёздочки" aria-label="Взять предложение в звёздочки">*…*</button>
        <button type="button" data-action="dash" title="Вставить длинное тире и пробел" aria-label="Вставить длинное тире и пробел">—</button>
        <button type="button" data-action="write" title="Написать за меня" aria-label="Написать за меня"><i class="fa-solid fa-feather-pointed" aria-hidden="true"></i></button>
        <span role="status"></span>`;
    row.before(toolbar);

    const write = toolbar.querySelector('[data-action="write"]');
    const status = toolbar.querySelector('[role="status"]');
    let revision = 0;
    let request;
    const invalidate = () => { revision++; };
    input.addEventListener('input', invalidate);
    const { eventSource, event_types: events } = getContext();
    eventSource.on(events.CHAT_CHANGED, () => {
        invalidate();
        request?.abort();
        status.textContent = '';
    });
    eventSource.on(events.GENERATION_STOPPED, () => {
        invalidate();
        request?.abort();
    });

    toolbar.addEventListener('mousedown', event => {
        if (event.target.closest('button')) event.preventDefault();
    });
    toolbar.querySelector('[data-action="stars"]').onclick = () => wrapSentence(input);
    toolbar.querySelector('[data-action="dash"]').onclick = () => {
        input.setRangeText('— ', input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
    };
    write.onclick = async () => {
        const context = getContext();
        const chatId = context.getCurrentChatId();
        const draft = input.value;
        const profileId = getProfileId();
        if (chatId == null || chatId === '') {
            status.textContent = 'Открой чат с персонажем.';
            return;
        }
        if (!profileId && context.onlineStatus === 'no_connection') {
            status.textContent = 'Сначала подключи модель.';
            return;
        }
        if (document.querySelector('#mes_stop')?.getClientRects().length) {
            status.textContent = 'Дождись окончания генерации.';
            return;
        }
        const group = context.groupId && context.groups.find(item => item.id === context.groupId);
        const forceChId = group ? context.characters.findIndex(character =>
            group.members.includes(character.avatar) && !group.disabled_members?.includes(character.avatar)) : null;
        if (context.groupId && (!group || forceChId < 0)) {
            status.textContent = 'В группе нужен активный персонаж.';
            return;
        }
        const requestRevision = revision;
        request = new AbortController();
        write.disabled = true;
        status.textContent = 'Пишу…';
        try {
            const quietPrompt = writerPrompt(context.name1, draft);
            const result = profileId
                ? await generateWithProfile(context, profileId, quietPrompt, request.signal)
                : await context.generateQuietPrompt({ quietPrompt, forceChId });
            if (chatId !== getContext().getCurrentChatId()) return;
            if (!isEnabled() || profileId !== getProfileId() || requestRevision !== revision || input.value !== draft) {
                status.textContent = '';
                return;
            }
            const text = String(result ?? '').trim().match(/^<post>([\s\S]*?)<\/post>$/u)?.[1].trim();
            if (!text) {
                status.textContent = 'Модель не соблюла формат ответа. Черновик сохранён.';
                return;
            }
            input.setRangeText(text, 0, draft.length, 'end');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            status.textContent = '';
        } catch (error) {
            if (!request.signal.aborted) console.warn('[Сюжетный пинок] Не удалось написать ответ', error);
            if (chatId === getContext().getCurrentChatId() && requestRevision === revision) {
                status.textContent = 'Не удалось написать ответ.';
            } else if (status.textContent === 'Пишу…') {
                status.textContent = '';
            }
        } finally {
            request = undefined;
            write.disabled = false;
        }
    };

    return toolbar;
}
