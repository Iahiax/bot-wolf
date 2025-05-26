const { WolfClient } = require('wolf.js');
const Redis = require('ioredis');
const fs = require('fs');
const yaml = require('yaml');
const categories = require('./categories'); // استيراد ملف الفئات

// قراءة بيانات الاعتماد من ملف config.yaml
const configPath = './config.yaml';
const config = yaml.parse(fs.readFileSync(configPath, 'utf8'));

const client = new WolfClient();
const redis = new Redis();

const BOT_NAME_AR = 'الجاسوس';
const BOT_NAME_EN = 'Spy';
const COMMAND_PREFIX_AR = '!جس';
const COMMAND_PREFIX_EN = '!s';
const FULL_COMMAND_PREFIX_AR = '!جاسوس';
const FULL_COMMAND_PREFIX_EN = '!spy';

// تخزين حالات الألعاب
const games = new Map(); // gameId -> { channelId, creatorId, players: Map<userId, {nickname, score}>, spyId, secretWord, categoryKey, gameType, timer, language, state: 'waiting_for_players' | 'in_game' | 'waiting_for_category_choice' }

// بيانات المستخدمين العامة (للنقاط على مستوى ولف)
async function getUserTotalScore(userId) {
    const score = await redis.get(`wolf_total_score:${userId}`);
    return parseInt(score || 0);
}

async function updateUserTotalScore(userId, change) {
    await redis.incrby(`wolf_total_score:${userId}`, change);
}

// الدخول للبوت
client.on('loginSuccess', async () => {
    console.log(`Logged in as ${client.currentSubscriber.nickname}!`);
    console.log('Bot is ready!');
});

// معالجة الرسائل
client.on('message', async (message) => {
    const { content, senderId, channelId, isGroup, source } = message;

    if (!isGroup) return; // البوت يعمل فقط في المجموعات

    const sender = await client.getSubscriber(senderId);
    const senderNickname = sender?.nickname || `User ${senderId}`;

    // أوامر المساعدة
    if (content === '!مساعده' || content === '!مساعدة' || content === '!s help' || content === '!spy help') {
        const helpMessage = source === 'arabic' ? `
/me
1- "!جس انشاء" او "!جاسوس انشاء" لإنشاء اللعبه .
2- "!جس انضم" او "!جاسوس انضم" للانضمام للعبه .
3- "!جس بدء" او "!جاسوس بدء" لبدء اللعبه .
4- "!جس طرد (رقم العضويه)" او "!جاسوس طرد (رقم العضويه)" لطرد لاعب معين .
5- "!جس انهاء" او "!جاسوس انهاء" لانهاء اللعبه .
6- "!جس مجموع القناه" او "!جاسوس مجموع القناه" لعرض ترتيبك في القناه.
7- "!جس مجموع ولف" او "!جاسوس مجموع ولف" لعرض مجموعك وترتيبك على مستوى ولف .
        ` : `
/me
1- "!s create" or "!spy create" to create the game.
2- "!s join" or "!spy join" to join the game.
3- "!s start" or "!spy start" to start the game.
4- "!s kick (membership number)" or "!spy kick (membership number)" to kick a specific player.
5- "!s end" or "!spy end" to end the game.
6- "!s total channel" or "!spy total channel" to view your rank in the channel.
7- "!s total wolf" or "!spy total wolf" to view your total score and rank in Wolf.
        `;
        await message.reply(helpMessage);
        return;
    }

    // أمر إنشاء اللعبة
    if (content === `${COMMAND_PREFIX_AR} انشاء` || content === `${FULL_COMMAND_PREFIX_AR} انشاء` ||
        content === `${COMMAND_PREFIX_EN} create` || content === `${FULL_COMMAND_PREFIX_EN} create`) {

        if (games.has(channelId)) {
            await message.reply(source === 'arabic' ? 'هناك لعبة جاسوس نشطة بالفعل في هذه القناة!' : 'A Spy game is already active in this channel!');
            return;
        }

        const game = {
            channelId,
            creatorId: senderId,
            players: new Map(), // userId -> { nickname, score }
            spyId: null,
            secretWord: null,
            categoryKey: null,
            gameType: null, // 'random' or 'specific'
            timer: null,
            language: source === 'arabic' ? 'arabic' : 'english',
            state: 'waiting_for_category_choice' // حالة جديدة
        };
        games.set(channelId, game);

        await message.reply(game.language === 'arabic' ?
            `/me ارحب يا بعد قلبي :
تبي تلعب بفئه معينه اكتب 1
تبي تلعب بشكل عشوائي اكتب 2` :
            `/me Welcome, my dear:
If you want to play with a specific category, type 1.
If you want to play randomly, type 2.`
        );

        // تعيين مؤقت لإنهاء اللعبة تلقائيًا بعد 5 دقائق إذا لم يتم اختيار نوع اللعب
        game.timer = setTimeout(async () => {
            if (games.has(channelId) && games.get(channelId).state === 'waiting_for_category_choice') {
                games.delete(channelId);
                await client.sendMessage(channelId, game.language === 'arabic' ? 'انتهت اللعبة تلقائيًا لعدم اختيار فئة اللعب.' : 'The game ended automatically because no category was chosen.');
            }
        }, 5 * 60 * 1000); // 5 دقائق
        return;
    }

    const currentGame = games.get(channelId);

    // معالجة اختيار الفئة أو اللعب العشوائي
    if (currentGame && currentGame.state === 'waiting_for_category_choice' && senderId === currentGame.creatorId) {
        if (content === '1') {
            clearTimeout(currentGame.timer); // إيقاف مؤقت عدم النشاط
            currentGame.gameType = 'specific';
            currentGame.state = 'waiting_for_players'; // العودة لحالة انتظار اللاعبين
            let categoryList = currentGame.language === 'arabic' ? '/me اختر حرف الفئة:\n' : '/me Choose category letter:\n';
            for (const key in categories) {
                categoryList += `${key.charAt(0).toUpperCase()} - ${currentGame.language === 'arabic' ? categories[key].name_ar : categories[key].name_en}\n`;
            }
            await message.reply(categoryList);

            // تعيين مؤقت لإنهاء اللعبة تلقائيًا بعد 5 دقائق إذا لم يتم اختيار الفئة
            currentGame.timer = setTimeout(async () => {
                if (games.has(channelId) && games.get(channelId).state === 'waiting_for_category_choice_after_1') { // تحديث الحالة
                    games.delete(channelId);
                    await client.sendMessage(channelId, currentGame.language === 'arabic' ? 'انتهت اللعبة تلقائيًا لعدم اختيار الفئة.' : 'The game ended automatically because no category was chosen.');
                }
            }, 5 * 60 * 1000); // 5 دقائق
            currentGame.state = 'waiting_for_category_choice_after_1'; // تحديث الحالة
            return;
        } else if (content === '2') {
            clearTimeout(currentGame.timer); // إيقاف مؤقت عدم النشاط
            currentGame.gameType = 'random';
            currentGame.state = 'waiting_for_players';
            await message.reply(currentGame.language === 'arabic' ? 'تم اختيار اللعب العشوائي! يمكنك الآن الانضمام إلى اللعبة.' : 'Random play chosen! You can now join the game.');
        } else {
            await message.reply(currentGame.language === 'arabic' ? 'اختر 1 أو 2.' : 'Choose 1 or 2.');
            return;
        }
    }

    // معالجة اختيار الفئة بعد اختيار 1
    if (currentGame && currentGame.state === 'waiting_for_category_choice_after_1' && senderId === currentGame.creatorId) {
        const categoryKey = Object.keys(categories).find(key => key.charAt(0).toUpperCase() === content.toUpperCase());
        if (categoryKey && categories[categoryKey]) {
            clearTimeout(currentGame.timer); // إيقاف مؤقت عدم النشاط
            currentGame.categoryKey = categoryKey;
            currentGame.state = 'waiting_for_players';
            await message.reply(currentGame.language === 'arabic' ? `تم اختيار فئة: ${categories[categoryKey].name_ar}. يمكنك الآن الانضمام إلى اللعبة.` : `Category chosen: ${categories[categoryKey].name_en}. You can now join the game.`);
        } else {
            await message.reply(currentGame.language === 'arabic' ? 'فئة غير صحيحة. يرجى اختيار حرف فئة صحيح.' : 'Invalid category. Please choose a correct category letter.');
            return;
        }
    }

    if (!currentGame || (currentGame.state !== 'waiting_for_players' && currentGame.state !== 'in_game')) {
        return; // لا توجد لعبة نشطة أو لم تبدأ بعد
    }

    // أمر الانضمام
    if (content === `${COMMAND_PREFIX_AR} انضم` || content === `${FULL_COMMAND_PREFIX_AR} انضم` ||
        content === `${COMMAND_PREFIX_EN} join` || content === `${FULL_COMMAND_PREFIX_EN} join`) {
        if (currentGame.players.has(senderId)) {
            await message.reply(currentGame.language === 'arabic' ? 'أنت بالفعل منضم للعبة!' : 'You are already in the game!');
            return;
        }
        currentGame.players.set(senderId, { nickname: senderNickname, score: 0 });
        await message.reply(currentGame.language === 'arabic' ? `انضم ${senderNickname} إلى اللعبة! عدد اللاعبين: ${currentGame.players.size}` : `${senderNickname} joined the game! Players: ${currentGame.players.size}`);
        return;
    }

    // أمر بدء اللعبة
    if (content === `${COMMAND_PREFIX_AR} بدء` || content === `${FULL_COMMAND_PREFIX_AR} بدء` ||
        content === `${COMMAND_PREFIX_EN} start` || content === `${FULL_COMMAND_PREFIX_EN} start`) {
        if (senderId !== currentGame.creatorId) {
            await message.reply(currentGame.language === 'arabic' ? 'فقط منشئ اللعبة يمكنه بدء اللعبة.' : 'Only the game creator can start the game.');
            return;
        }

        // --- التعديل هنا: يجب أن يكون هناك 3 لاعبين على الأقل ---
        if (currentGame.players.size < 3) {
            await message.reply(currentGame.language === 'arabic' ? 'تحتاج إلى 3 لاعبين على الأقل لبدء اللعبة.' : 'You need at least 3 players to start the game.');
            return;
        }

        currentGame.state = 'in_game';
        clearTimeout(currentGame.timer); // إيقاف مؤقت عدم النشاط بعد بدء اللعبة
        await startGame(currentGame);
        return;
    }

    // أمر تخمين الجاسوس
    const guessCommandAr = new RegExp(`^(${COMMAND_PREFIX_AR}|${FULL_COMMAND_PREFIX_AR})\\s+(\\d+)$`);
    const guessCommandEn = new RegExp(`^(${COMMAND_PREFIX_EN}|${FULL_COMMAND_PREFIX_EN})\\s+(\\d+)$`);

    let match = content.match(guessCommandAr) || content.match(guessCommandEn);
    if (match && currentGame.state === 'in_game') {
        const suspectedId = parseInt(match[2]);

        if (isNaN(suspectedId) || !currentGame.players.has(suspectedId)) {
            await message.reply(currentGame.language === 'arabic' ? 'عضوية غير صحيحة أو اللاعب ليس في اللعبة.' : 'Invalid membership ID or player not in game.');
            return;
        }

        // تسجيل تخمين اللاعب
        currentGame.players.get(senderId).guessedSpy = suspectedId;
        await client.sendMessage(channelId, currentGame.language === 'arabic' ? `${senderNickname} وضع تخمينه.` : `${senderNickname} placed their guess.`);

        const allGuessed = Array.from(currentGame.players.values()).every(player => player.guessedSpy !== undefined);

        if (allGuessed) {
            await endGame(currentGame);
        } else {
             // تعيين مؤقت لإنهاء اللعبة تلقائيًا إذا لم يضع الجميع تخميناتهم
             currentGame.timer = setTimeout(async () => {
                if (games.has(channelId) && games.get(channelId).state === 'in_game' && !allGuessed) {
                    await client.sendMessage(channelId, currentGame.language === 'arabic' ? 'انتهت اللعبة تلقائيًا لعدم وضع جميع اللاعبين تخميناتهم.' : 'The game ended automatically because not all players placed their guesses.');
                    await endGame(currentGame);
                }
            }, 5 * 60 * 1000); // 5 دقائق
        }
        return;
    }

    // أمر طرد لاعب
    const kickCommandAr = new RegExp(`^(${COMMAND_PREFIX_AR}|${FULL_COMMAND_PREFIX_AR})\\s+طرد\\s+(\\d+)$`);
    const kickCommandEn = new RegExp(`^(${COMMAND_PREFIX_EN}|${FULL_COMMAND_PREFIX_EN})\\s+kick\\s+(\\d+)$`);

    match = content.match(kickCommandAr) || content.match(kickCommandEn);
    if (match && currentGame && senderId === currentGame.creatorId) {
        const userIdToKick = parseInt(match[2]);
        if (isNaN(userIdToKick)) {
            await message.reply(currentGame.language === 'arabic' ? 'يرجى إدخال رقم عضوية صحيح.' : 'Please enter a valid membership ID.');
            return;
        }
        if (currentGame.players.has(userIdToKick)) {
            const kickedPlayerNickname = currentGame.players.get(userIdToKick).nickname;
            currentGame.players.delete(userIdToKick);
            await message.reply(currentGame.language === 'arabic' ? `${kickedPlayerNickname} تم طرده من اللعبة.` : `${kickedPlayerNickname} has been kicked from the game.`);
            // --- التعديل هنا: التحقق من عدد اللاعبين بعد الطرد ---
            if (currentGame.state === 'in_game' && currentGame.players.size < 3) {
                 await message.reply(currentGame.language === 'arabic' ? 'عدد اللاعبين أقل من 3. تم إنهاء اللعبة.' : 'Less than 3 players. Game ended.');
                 await endGame(currentGame);
            } else if (currentGame.state === 'in_game' && Array.from(currentGame.players.values()).every(player => player.guessedSpy !== undefined)) {
                await endGame(currentGame);
            }
        } else {
            await message.reply(currentGame.language === 'arabic' ? 'هذا اللاعب ليس في اللعبة.' : 'This player is not in the game.');
        }
        return;
    }

    // أمر إنهاء اللعبة
    if (content === `${COMMAND_PREFIX_AR} انهاء` || content === `${FULL_COMMAND_PREFIX_AR} انهاء` ||
        content === `${COMMAND_PREFIX_EN} end` || content === `${FULL_COMMAND_PREFIX_EN} end`) {
        if (currentGame && senderId === currentGame.creatorId) {
            clearTimeout(currentGame.timer); // إيقاف أي مؤقت نشط
            await endGame(currentGame);
            await message.reply(currentGame.language === 'arabic' ? 'تم إنهاء اللعبة بواسطة المنشئ.' : 'Game ended by creator.');
        } else {
            await message.reply(currentGame.language === 'arabic' ? 'لا توجد لعبة نشطة لإنهاءها أو أنت لست منشئ اللعبة.' : 'No active game to end or you are not the game creator.');
        }
        return;
    }

    // أمر نقاط القناة
    if (content === `${COMMAND_PREFIX_AR} مجموع القناه` || content === `${FULL_COMMAND_PREFIX_AR} مجموع القناه` ||
        content === `${COMMAND_PREFIX_AR} مجموع القناة` || content === `${FULL_COMMAND_PREFIX_AR} مجموع القناة` ||
        content === `${COMMAND_PREFIX_EN} total channel` || content === `${FULL_COMMAND_PREFIX_EN} total channel`) {

        const channelScores = await redis.hgetall(`channel_scores:${channelId}`);
        let replyMessage = currentGame?.language === 'arabic' ? '/me نقاط اللاعبين في هذه القناة:\n' : '/me Player scores in this channel:\n';
        let hasScores = false;
        for (const userId in channelScores) {
            hasScores = true;
            const score = parseInt(channelScores[userId]);
            const user = await client.getSubscriber(parseInt(userId));
            const nickname = user?.nickname || `User ${userId}`;
            replyMessage += `${nickname}: ${score}\n`;
        }
        if (!hasScores) {
            replyMessage += currentGame?.language === 'arabic' ? 'لا توجد نقاط مسجلة في هذه القناة بعد.' : 'No scores recorded in this channel yet.';
        }
        await message.reply(replyMessage);
        return;
    }

    // أمر نقاط ولف الكلية
    if (content === `${COMMAND_PREFIX_AR} مجموع ولف` || content === `${FULL_COMMAND_PREFIX_AR} مجموع ولف` ||
        content === `${COMMAND_PREFIX_EN} total wolf` || content === `${FULL_COMMAND_PREFIX_EN} total wolf`) {
        const allScoresKeys = await redis.keys('wolf_total_score:*');
        let allScores = [];
        for (const key of allScoresKeys) {
            const userId = parseInt(key.split(':')[1]);
            const score = await getUserTotalScore(userId);
            const user = await client.getSubscriber(userId);
            const nickname = user?.nickname || `User ${userId}`;
            allScores.push({ userId, nickname, score });
        }

        allScores.sort((a, b) => b.score - a.score);

        let replyMessage = currentGame?.language === 'arabic' ? '/me ترتيب نقاط اللاعبين على مستوى ولف:\n' : '/me Player scores ranking across Wolf:\n';
        if (allScores.length > 0) {
            allScores.forEach((player, index) => {
                replyMessage += `${index + 1}. ${player.nickname}: ${player.score}\n`;
            });
        } else {
            replyMessage += currentGame?.language === 'arabic' ? 'لا توجد نقاط مسجلة على مستوى ولف بعد.' : 'No scores recorded across Wolf yet.';
        }
        await message.reply(replyMessage);
        return;
    }
});

// بدء اللعبة
async function startGame(game) {
    // اختيار كلمة سر وفئة
    let chosenCategory;
    let secretWord;

    if (game.gameType === 'random') {
        const categoryKeys = Object.keys(categories);
        const randomCategoryKey = categoryKeys[Math.floor(Math.random() * categoryKeys.length)];
        chosenCategory = categories[randomCategoryKey];
    } else { // specific
        chosenCategory = categories[game.categoryKey];
    }

    if (!chosenCategory || chosenCategory.items.length === 0) {
        await client.sendMessage(game.channelId, game.language === 'arabic' ? 'حدث خطأ: لا توجد عناصر في الفئة المختارة.' : 'Error: No items in the chosen category.');
        games.delete(game.channelId);
        return;
    }

    secretWord = chosenCategory.items[Math.floor(Math.random() * chosenCategory.items.length)];
    game.secretWord = secretWord;
    game.categoryKey = Object.keys(categories).find(key => categories[key] === chosenCategory); // تخزين المفتاح الصحيح

    // اختيار الجاسوس
    const playerIds = Array.from(game.players.keys());
    const spyId = playerIds[Math.floor(Math.random() * playerIds.length)];
    game.spyId = spyId;

    // إرسال الرسائل الخاصة
    for (const [userId, playerData] of game.players.entries()) {
        if (userId === spyId) {
            await client.sendMessage(userId, game.language === 'arabic' ? `أنت الجاسوس 🥷! حاول التمويه على بقية اللاعبين. لا تعرف الكلمة السرية.` : `You are the Spy 🥷! Try to bluff the other players. You don't know the secret word.`);
        } else {
            await client.sendMessage(userId, game.language === 'arabic' ?
                `الكلمة السرية هي: "${secretWord}" (الفئة: ${chosenCategory.name_ar}). مهمتك هي اكتشاف الجاسوس.` :
                `The secret word is: "${secretWord}" (Category: ${chosenCategory.name_en}). Your mission is to find the spy.`
            );
        }
    }

    await client.sendMessage(game.channelId, game.language === 'arabic' ?
        '/me تم بدء اللعبة! ابدأوا في البحث عن الجاسوس. تذكروا، لكل لاعب تخمين واحد. استخدموا الأمر ( !جس رقم_العضوية ) أو ( !جاسوس رقم_العضوية ) لتحديد الجاسوس.' :
        '/me Game started! Begin your hunt for the spy. Remember, each player has one guess. Use the command (!s membership_ID) or (!spy membership_ID) to identify the spy.'
    );

    // تعيين مؤقت لإنهاء اللعبة تلقائيًا إذا لم يضع الجميع تخميناتهم
    game.timer = setTimeout(async () => {
        if (games.has(game.channelId) && games.get(game.channelId).state === 'in_game' && !Array.from(game.players.values()).every(player => player.guessedSpy !== undefined)) {
            await client.sendMessage(game.channelId, game.language === 'arabic' ? 'انتهت اللعبة تلقائيًا لعدم وضع جميع اللاعبين تخميناتهم.' : 'The game ended automatically because not all players placed their guesses.');
            await endGame(game);
        }
    }, 5 * 60 * 1000); // 5 دقائق

}

// إنهاء اللعبة وحساب النقاط
async function endGame(game) {
    if (game.state === 'ended') return; // منع الإنهاء المتعدد
    game.state = 'ended';

    clearTimeout(game.timer); // إيقاف أي مؤقت نشط

    let spyFound = false;
    let correctGuessers = new Set();
    let incorrectGuessers = new Set();

    // تحليل تخمينات اللاعبين
    for (const [guesserId, playerData] of game.players.entries()) {
        if (guesserId === game.spyId) continue; // الجاسوس لا يخمن
        if (playerData.guessedSpy !== undefined) {
            if (playerData.guessedSpy === game.spyId) {
                correctGuessers.add(guesserId);
            } else {
                incorrectGuessers.add(guesserId);
            }
        }
    }

    // الإعلان عن الجاسوس
    const spyNickname = game.players.get(game.spyId)?.nickname || `الجاسوس (ID: ${game.spyId})`;
    await client.sendMessage(game.channelId, game.language === 'arabic' ?
        `/alert الجاسوس هو: ${spyNickname} 🥷` :
        `/alert The Spy is: ${spyNickname} 🥷`
    );

    // حساب النقاط
    let resultsMessage = game.language === 'arabic' ? '/me قائمة نتائج اللاعبين:\n' : '/me Player Results:\n';

    // نقاط الجاسوس
    let spyScoreChange = 0;
    if (correctGuessers.size > 0) { // الجاسوس خسر إذا تم اكتشافه
        spyScoreChange = -1 * correctGuessers.size; // خسر نقطة لكل من اكتشفه
    } else { // الجاسوس فاز إذا لم يتم اكتشافه
        spyScoreChange = game.players.size - 1; // يكسب نقطة عن كل لاعب لم يكتشفه
    }
    game.players.get(game.spyId).score += spyScoreChange;
    await updateChannelScore(game.channelId, game.spyId, spyScoreChange);
    await updateUserTotalScore(game.spyId, spyScoreChange);

    // نقاط اللاعبين الآخرين
    for (const [userId, playerData] of game.players.entries()) {
        if (userId === game.spyId) {
            resultsMessage += `${playerData.nickname}: ${spyScoreChange > 0 ? '+' : ''}${spyScoreChange} (مجموع: ${await getPlayerChannelScore(game.channelId, userId)})\n`;
            continue;
        }

        let playerScoreChange = 0;
        if (correctGuessers.has(userId)) {
            playerScoreChange = 1; // كسب نقطة لاكتشاف الجاسوس
        } else if (playerData.guessedSpy !== undefined) {
            playerScoreChange = -1; // خسر نقطة لتخمين خاطئ
        } else {
            // اللاعب الذي لم يضع تخمينه لا يفوز ولا يخسر نقاط
        }

        playerData.score += playerScoreChange;
        await updateChannelScore(game.channelId, userId, playerScoreChange);
        await updateUserTotalScore(userId, playerScoreChange);
        resultsMessage += `${playerData.nickname}: ${playerScoreChange > 0 ? '+' : ''}${playerScoreChange} (مجموع: ${await getPlayerChannelScore(game.channelId, userId)})\n`;
    }

    await client.sendMessage(game.channelId, resultsMessage);

    games.delete(game.channelId); // إزالة اللعبة من القائمة بعد الانتهاء

    // سؤال عن الاستمرار
    await client.sendMessage(game.channelId, game.language === 'arabic' ?
        `لو تبي تكمل يا قلبي ارسل رقم 1` :
        `If you want to continue, my dear, send number 1.`
    );

    // تعيين مؤقت لاستئناف اللعبة إذا اختار المنشئ ذلك
    const creatorId = game.creatorId;
    const channelId = game.channelId;
    const gameType = game.gameType;
    const categoryKey = game.categoryKey;
    const language = game.language;

    const continueGameListener = client.on('message', async (message) => {
        if (message.channelId === channelId && message.senderId === creatorId && message.content === '1') {
            client.off('message', continueGameListener); // إزالة المستمع
            const newGame = {
                channelId,
                creatorId,
                players: new Map(), // إعادة تهيئة اللاعبين للجولة الجديدة
                spyId: null,
                secretWord: null,
                categoryKey, // احتفاظ بنفس الفئة أو نوع اللعب
                gameType,
                timer: null,
                language,
                state: 'waiting_for_players'
            };
            games.set(channelId, newGame);
            await client.sendMessage(channelId, language === 'arabic' ? 'جولة جديدة بدأت! يمكنكم الانضمام الآن.' : 'New round started! You can join now.');
            // يمكنك هنا إعادة تشغيل المؤقت لإنهاء اللعبة تلقائيا في حال عدم وجود لاعبين
            newGame.timer = setTimeout(async () => {
                if (games.has(channelId) && games.get(channelId).state === 'waiting_for_players') {
                    games.delete(channelId);
                    await client.sendMessage(channelId, language === 'arabic' ? 'انتهت اللعبة تلقائيًا لعدم انضمام اللاعبين.' : 'The game ended automatically because no players joined.');
                }
            }, 5 * 60 * 1000); // 5 دقائق
        } else if (message.channelId === channelId && message.senderId === creatorId && message.content !== '1') {
            // إذا أرسل المنشئ شيئًا آخر، فافترض أنه لا يريد المتابعة، ولكن لا تنهي اللعبة إلا بعد انتهاء المؤقت.
        }
    });

    // مؤقت لإزالة المستمع إذا لم يستجب المنشئ خلال 5 دقائق
    setTimeout(() => {
        client.off('message', continueGameListener);
        if (!games.has(channelId)) { // تأكد أن اللعبة لم تستأنف بالفعل
            // لا تفعل شيئا، اللعبة انتهت بالفعل.
        }
    }, 5 * 60 * 1000); // 5 دقائق
}

// تحديث نقاط القناة
async function updateChannelScore(channelId, userId, change) {
    await redis.hincrby(`channel_scores:${channelId}`, userId.toString(), change);
}

// الحصول على نقاط اللاعب في القناة
async function getPlayerChannelScore(channelId, userId) {
    const score = await redis.hget(`channel_scores:${channelId}`, userId.toString());
    return parseInt(score || 0);
}


// تسجيل الدخول
client.login(config.email, config.password);

