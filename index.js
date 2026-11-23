(function () {
    "use strict";
    // 메세지청소 — Endcord Mobile 커뮤니티 플러그인 (Vendetta/Revenge 형식)
    // 주의: 이 파일의 맨 첫 글자는 반드시 "(" 여야 합니다. 위에 빈 줄이나 주석을 넣으면 플러그인이 로드되지 않아요.

    /* ===== 설정 (원하면 숫자만 바꾸세요) ===== */
    var MAX_COUNT = 500;        // 한 번에 지울 수 있는 최대 개수
    var DELETE_DELAY = 1200;    // 하나 지운 뒤 쉬는 시간(ms). 낮추면 빨라지지만 속도 제한·계정 위험이 커져요
    var FETCH_DELAY = 700;      // 메시지 목록을 100개씩 불러올 때 쉬는 시간(ms)
    var SCAN_LIMIT = 5000;      // 내 메시지를 찾으려고 거슬러 올라갈 최대 메시지 수
    var SKIP_PINNED = true;     // 고정(핀)된 메시지는 건너뛰기
    var STOP_AFTER_FAILS = 5;   // 연속으로 이만큼 실패하면 멈춤 (권한 없음 등)

    var metro = vendetta.metro;
    var unregisters = [];
    var job = null; // 진행 중인 청소 작업

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function getRest() {
        return metro.findByProps("getAPIBaseURL", "get") || metro.findByProps("get", "post", "del", "patch");
    }

    function getMyId() {
        var UserStore = metro.findByStoreName("UserStore");
        var me = UserStore && UserStore.getCurrentUser && UserStore.getCurrentUser();
        return me ? me.id : null;
    }

    function toast(text) {
        try { vendetta.ui.toasts.showToast(text); } catch (e) { /* 무시 */ }
    }

    // 나에게만 보이는 안내 메시지 (다른 사람에게는 안 보여요)
    function notify(channelId, text) {
        try {
            var messageUtil = metro.findByProps("sendBotMessage");
            if (messageUtil && messageUtil.sendBotMessage) {
                messageUtil.sendBotMessage(channelId, text);
                return;
            }
        } catch (e) { /* 아래 토스트로 대신 */ }
        toast(text);
    }

    function getArg(args, name) {
        for (var i = 0; i < (args || []).length; i++) {
            if (args[i] && args[i].name === name) return args[i].value;
        }
        return undefined;
    }

    // 속도 제한(429)일 때 디스코드가 알려준 시간만큼 기다리기
    function waitTime(e) {
        var sec = e && e.body && e.body.retry_after;
        return (typeof sec === "number" ? sec * 1000 : 3000) + 300;
    }

    function fetchPage(rest, channelId, before, tries) {
        var query = { limit: 100 };
        if (before) query.before = before;
        return rest.get({ url: "/channels/" + channelId + "/messages", query: query }).then(
            function (res) { return (res && res.body) || []; },
            function (e) {
                if (e && e.status === 429 && tries < 5) {
                    return sleep(waitTime(e)).then(function () {
                        return fetchPage(rest, channelId, before, tries + 1);
                    });
                }
                throw e;
            }
        );
    }

    function deleteOne(rest, channelId, messageId, tries) {
        return rest.del({ url: "/channels/" + channelId + "/messages/" + messageId }).then(
            function () { return "ok"; },
            function (e) {
                var status = e && e.status;
                if (status === 429 && tries < 5) {
                    return sleep(waitTime(e)).then(function () {
                        return deleteOne(rest, channelId, messageId, tries + 1);
                    });
                }
                if (status === 404) return "gone"; // 이미 지워짐
                return "fail";
            }
        );
    }

    // 지울 메시지 ID 모으기 (최신 → 과거 순)
    function collect(rest, state) {
        var ids = [];
        var scanned = 0;
        var before = null;

        function next() {
            if (state.cancelled || ids.length >= state.count || scanned >= SCAN_LIMIT) {
                return Promise.resolve(ids);
            }
            return fetchPage(rest, state.channelId, before, 0).then(function (msgs) {
                if (!msgs.length) return ids;
                for (var i = 0; i < msgs.length && ids.length < state.count; i++) {
                    var m = msgs[i];
                    scanned++;
                    if (SKIP_PINNED && m.pinned) continue;
                    if (state.includeOthers) {
                        ids.push(m.id);
                    } else if (m.author && m.author.id === state.myId && (m.type === 0 || m.type === 19)) {
                        ids.push(m.id); // 내 일반 메시지·답장만
                    }
                }
                before = msgs[msgs.length - 1].id;
                if (msgs.length < 100) return ids; // 채널 끝까지 봄
                return sleep(FETCH_DELAY).then(next);
            });
        }
        return next();
    }

    // 하나씩 천천히 삭제 (일반 계정은 대량 삭제 API를 쓸 수 없어요)
    function purge(rest, state, ids) {
        var i = 0, ok = 0, fail = 0, failStreak = 0;

        function next() {
            if (state.cancelled || i >= ids.length) {
                return Promise.resolve({ ok: ok, fail: fail, stoppedByFails: false });
            }
            if (failStreak >= STOP_AFTER_FAILS) {
                return Promise.resolve({ ok: ok, fail: fail, stoppedByFails: true });
            }
            var id = ids[i++];
            return deleteOne(rest, state.channelId, id, 0).then(function (r) {
                if (r === "fail") { fail++; failStreak++; } else { ok++; failStreak = 0; }
                if (i % 50 === 0 && i < ids.length) toast("🧹 메세지청소 " + i + " / " + ids.length);
                return sleep(DELETE_DELAY).then(next);
            });
        }
        return next();
    }

    function startJob(channelId, count, includeOthers) {
        var rest = getRest();
        var myId = getMyId();
        if (!rest || typeof rest.get !== "function" || typeof rest.del !== "function") {
            notify(channelId, "❌ 디스코드 요청 모듈을 찾지 못했어요. 디스코드나 엔드코드 업데이트로 바뀐 것 같아요.");
            return;
        }
        if (!myId) {
            notify(channelId, "❌ 내 계정 정보를 불러오지 못했어요. 앱을 다시 열고 시도해 주세요.");
            return;
        }

        var state = { channelId: channelId, count: count, includeOthers: includeOthers, myId: myId, cancelled: false };
        job = state;
        notify(channelId, "🔍 지울 메시지를 찾는 중이에요... (멈추기: /청소중지)");

        collect(rest, state).then(function (ids) {
            if (state.cancelled) return { ok: 0, fail: 0, stoppedByFails: false };
            if (!ids.length) {
                notify(channelId, "🤔 지울 메시지를 찾지 못했어요.");
                return null;
            }
            var minutes = Math.max(1, Math.ceil(ids.length * (DELETE_DELAY + 200) / 60000));
            notify(channelId, "🧹 " + ids.length + "개 삭제를 시작해요! 예상 약 " + minutes + "분 (멈추기: /청소중지)");
            return purge(rest, state, ids);
        }).then(function (result) {
            if (!result) return;
            var title = state.cancelled ? "⏹️ 청소를 멈췄어요"
                : result.stoppedByFails ? "⚠️ 청소를 중단했어요" : "✅ 청소 완료";
            var text = title +
                " — 삭제 " + result.ok + "개" + (result.fail ? ", 실패 " + result.fail + "개" : "");
            if (result.stoppedByFails) {
                text += "\n⚠️ 연속으로 실패해서 멈췄어요. 다른 사람 메시지를 지우려면 '메시지 관리' 권한이 필요해요.";
            }
            notify(channelId, text);
        }).catch(function (e) {
            var status = e && e.status;
            var reason = status === 403 ? "이 채널의 메시지 기록을 볼 권한이 없어요."
                : (e && e.message) || (status ? "HTTP " + status : String(e));
            notify(channelId, "❌ 오류가 났어요: " + reason);
        }).then(function () {
            if (job === state) job = null;
        });
    }

    function confirmThen(title, content, onYes) {
        try {
            vendetta.ui.alerts.showConfirmationAlert({
                title: title,
                content: content,
                confirmText: "삭제",
                cancelText: "취소",
                onConfirm: onYes
            });
        } catch (e) {
            onYes();
        }
    }

    return {
        onLoad: function () {
            unregisters.push(vendetta.commands.registerCommand({
                name: "메세지청소",
                displayName: "메세지청소",
                description: "이 채널의 최근 메시지를 지정한 개수만큼 삭제해요 (최대 500개)",
                displayDescription: "이 채널의 최근 메시지를 지정한 개수만큼 삭제해요 (최대 500개)",
                options: [
                    {
                        name: "갯수",
                        displayName: "갯수",
                        description: "삭제할 메시지 수 (1~500)",
                        displayDescription: "삭제할 메시지 수 (1~500)",
                        type: 4, // INTEGER
                        required: true,
                        min_value: 1,
                        max_value: MAX_COUNT
                    },
                    {
                        name: "전체",
                        displayName: "전체",
                        description: "다른 사람 메시지도 삭제 (메시지 관리 권한 필요, 기본은 내 메시지만)",
                        displayDescription: "다른 사람 메시지도 삭제 (메시지 관리 권한 필요, 기본은 내 메시지만)",
                        type: 5, // BOOLEAN
                        required: false
                    }
                ],
                execute: function (args, ctx) {
                    var channelId = ctx && ctx.channel && ctx.channel.id;
                    if (!channelId) return;

                    var count = parseInt(String(getArg(args, "갯수")), 10);
                    var others = getArg(args, "전체");
                    var includeOthers = others === true || String(others) === "true";

                    if (!(count >= 1)) {
                        notify(channelId, "❌ 갯수는 1 이상의 숫자로 적어 주세요. 예) /메세지청소 50");
                        return;
                    }
                    if (count > MAX_COUNT) {
                        notify(channelId, "⚠️ 최대 " + MAX_COUNT + "개까지만 가능해서 " + MAX_COUNT + "개로 맞췄어요.");
                        count = MAX_COUNT;
                    }
                    if (job) {
                        notify(channelId, "⏳ 이미 청소 중이에요. 먼저 /청소중지 로 멈춰 주세요.");
                        return;
                    }

                    var target = includeOthers ? "이 채널의 최근 메시지" : "이 채널에서 내가 보낸 최근 메시지";
                    confirmThen(
                        "메세지청소",
                        target + " " + count + "개를 삭제할까요?\n삭제한 메시지는 되돌릴 수 없어요." +
                            (SKIP_PINNED ? "\n(고정된 메시지는 건너뛰어요)" : ""),
                        function () { startJob(channelId, count, includeOthers); }
                    );
                    // 아무것도 반환하지 않기: 객체를 반환하면 채팅으로 전송돼요
                }
            }));

            unregisters.push(vendetta.commands.registerCommand({
                name: "청소중지",
                displayName: "청소중지",
                description: "진행 중인 메세지청소를 멈춰요",
                displayDescription: "진행 중인 메세지청소를 멈춰요",
                options: [],
                execute: function (args, ctx) {
                    var channelId = ctx && ctx.channel && ctx.channel.id;
                    if (!job) {
                        if (channelId) notify(channelId, "진행 중인 청소가 없어요.");
                        return;
                    }
                    job.cancelled = true;
                    if (channelId) notify(channelId, "⏹️ 멈추는 중이에요... 곧 결과를 알려 드릴게요.");
                }
            }));
        },

        onUnload: function () {
            if (job) job.cancelled = true;
            job = null;
            for (var i = 0; i < unregisters.length; i++) {
                try { unregisters[i](); } catch (e) { /* 무시 */ }
            }
            unregisters = [];
        }
    };
})()
