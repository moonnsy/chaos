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
export const defaultWriterInstruction = 'Напиши один пост от лица персонажа игрока. Сохрани его намерение, язык и стиль чата. Только персонаж игрока говорит, думает и действует в новом посте. Используй историю для понимания сцены. Если черновика нет, предложи короткую уместную реакцию без важных решений за игрока.';

async function customMessages(context, instruction, draft, characterId, budget) {
    const card = context.getCharacterCardFields({ chid: characterId ?? undefined });
    const history = context.chat.filter(message => !message.is_system);
    const lore = await context.getWorldInfoPrompt(
        history.map(message => `${message.name}: ${message.mes}`).reverse(), budget, true,
        {
            personaDescription: card.persona, characterDescription: card.description,
            characterPersonality: card.personality, characterDepthPrompt: card.charDepthPrompt,
            scenario: card.scenario, creatorNotes: card.creatorNotes, trigger: 'normal',
        },
    );
    const interval = Number(context.chatMetadata.note_interval);
    const turns = history.filter(message => message.is_user).length;
    const note = interval === 1 || (interval > 1 && turns > 0 && turns % interval === 0)
        ? context.chatMetadata.note_prompt : '';
    const background = [
        ['Персона игрока', card.persona], ['Описание персонажа', card.description],
        ['Характер', card.personality], ['Сценарий', card.scenario],
        ['Примеры диалога', card.mesExamples], ['Контекст персонажа', card.charDepthPrompt],
        ['Авторская заметка', note],
        ['Лор', [
            lore.worldInfoBefore, lore.worldInfoAfter,
            ...lore.worldInfoExamples.map(entry => entry.content),
            ...lore.worldInfoDepth.flatMap(entry => entry.entries),
            ...lore.anBefore, ...lore.anAfter,
        ].filter(Boolean).join('\n')],
    ].filter(([, value]) => value).map(([label, value]) => `${label}:\n${value}`).join('\n\n');
    const system = { role: 'system', content: `${instruction}\n\n${background}`.trim() };
    const task = { role: 'user', content: [
        `Сейчас ход персонажа игрока: ${context.name1}.`,
        draft.trim() ? `Черновик игрока: ${draft.trim()}` : 'Черновика нет.',
        'Верни только текст поста внутри <post> и </post>.',
    ].join('\n') };
    let remaining = budget - await context.getTokenCountAsync(system.content + '\n' + task.content, 24);
    if (remaining < 0) throw new Error('Инструкция и контекст не помещаются в лимит модели.');
    const messages = [];
    for (const message of history.slice().reverse()) {
        const content = `${message.name}: ${message.mes}`;
        remaining -= await context.getTokenCountAsync(content, 6);
        if (remaining < 0) break;
        messages.push({ role: message.is_user ? 'user' : 'assistant', content });
    }
    return [system, ...messages.reverse(), task];
}

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

async function generateWithProfile(context, profileId, quietPrompt, signal, buildMessages) {
    const service = context.ConnectionManagerRequestService;
    const profile = context.extensionSettings.connectionManager?.profiles?.find(item => item.id === profileId);
    if (!service || !profile || context.extensionSettings.disabledExtensions?.includes('connection-manager')) {
        throw new Error('Профиль пера недоступен.');
    }
    const api = service.validateProfile(profile).selected;
    const preset = context.getPresetManager?.(api)?.getCompletionPresetByName(profile.preset);
    const { eventSource, event_types: events } = context;
    let payload;
    const capture = (data, dryRun) => {
        const prompt = data?.prompt;
        const containsTask = typeof prompt === 'string' ? prompt.includes(writerTask)
            : Array.isArray(prompt) && prompt.some(message => JSON.stringify(message.content ?? '').includes(writerTask));
        if (dryRun && containsTask) payload = structuredClone(data);
    };
    if (!buildMessages) {
        eventSource.on(events.GENERATE_AFTER_DATA, capture);
        try {
            await context.generate('quiet', { quiet_prompt: quietPrompt, force_name2: true }, true);
        } finally {
            eventSource.removeListener(events.GENERATE_AFTER_DATA, capture);
        }
        if (!payload) throw new Error('SillyTavern не собрала промпт для пера.');
    }
    const maxTokens = Number(preset?.openai_max_tokens ?? preset?.genamt ?? payload?.max_tokens ?? payload?.max_length
        ?? context.chatCompletionSettings?.openai_max_tokens) || 512;
    const contextLimit = Number(preset?.openai_max_context ?? preset?.max_length) || context.maxContext;
    let prompt = buildMessages ? await buildMessages(contextLimit - maxTokens) : payload.prompt;
    if (api === 'openai' && typeof prompt === 'string') prompt = [{ role: 'user', content: prompt }];
    signal.throwIfAborted();
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

export function mountComposer(getContext, getSettings, wandButton) {
    const isEnabled = () => Boolean(getSettings().quickButtons || getSettings().writerInWand);
    const getProfileId = () => getSettings().writerProfile ?? '';
    const input = document.querySelector('#send_textarea');
    const row = input?.closest('#nonQRFormItems');
    if (!row) return;

    const toolbar = document.createElement('div');
    toolbar.id = 'plot-nudge-composer';
    toolbar.hidden = !getSettings().quickButtons;
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', 'Быстрые кнопки ввода');
    toolbar.innerHTML = `
        <button type="button" data-action="stars" title="Взять предложение в звёздочки" aria-label="Взять предложение в звёздочки">*…*</button>
        <button type="button" data-action="dash" title="Вставить длинное тире и пробел" aria-label="Вставить длинное тире и пробел">—</button>
        <button type="button" data-action="write" title="Написать за меня" aria-label="Написать за меня"><i class="fa-solid fa-feather-pointed" aria-hidden="true"></i></button>
        <span role="status"></span>`;
    row.before(toolbar);

    const write = toolbar.querySelector('[data-action="write"]');
    const indicator = toolbar.querySelector('[role="status"]');
    const status = {
        get textContent() { return indicator.textContent; },
        set textContent(text) {
            indicator.textContent = text;
            if (toolbar.hidden && text) globalThis.toastr?.info(text);
        },
    };
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
    write.onclick = wandButton.onclick = async () => {
        if (request) return;
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
        wandButton.disabled = true;
        status.textContent = 'Пишу…';
        try {
            const quietPrompt = writerPrompt(context.name1, draft);
            const buildMessages = getSettings().writerCustomPrompt
                ? budget => customMessages(context, getSettings().writerInstruction?.trim() || defaultWriterInstruction,
                    draft, forceChId, budget)
                : null;
            let result;
            if (profileId) {
                result = await generateWithProfile(context, profileId, quietPrompt, request.signal, buildMessages);
            } else if (buildMessages) {
                const completion = context.mainApi === 'openai' ? context.chatCompletionSettings : null;
                const responseLength = Number(completion?.openai_max_tokens ?? document.querySelector('#amount_gen')?.value) || 512;
                const messages = await buildMessages((Number(completion?.openai_max_context) || context.maxContext) - responseLength);
                request.signal.throwIfAborted();
                result = await context.generateRaw({ systemPrompt: messages.shift().content, prompt: messages, trimNames: false });
            } else {
                result = await context.generateQuietPrompt({ quietPrompt, forceChId });
            }
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
            wandButton.disabled = false;
        }
    };

    return toolbar;
}
