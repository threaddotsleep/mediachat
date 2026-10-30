        const imageRoute = location.pathname.match(/^\/image\/([0-9a-f-]{36})$/i);
        const galleryView = document.querySelector("#gallery-view");
        const detailView = document.querySelector("#detail-view");
        const form = document.querySelector("#upload-form");
        const fileInput = document.querySelector("#file");
        const fileName = document.querySelector("#file-name");
        const dropZone = document.querySelector("#upload");
        const status = document.querySelector("#status");
        const grid = document.querySelector("#image-grid");
        const emptyState = document.querySelector("#empty-state");
        const count = document.querySelector("#live-count");
        const total = document.querySelector("#feed-total");
        const submitButton = document.querySelector("#submit-button");
        const categoryList = document.querySelector("#category-list");
        const allCategoryCount = document.querySelector("#all-category-count");
        const uploadDestination = document.querySelector("#upload-destination");
        const turnstileSiteKey = document.querySelector("meta[name='turnstile-site-key']")?.content ?? "";
        let uploadCaptchaToken = "";
        let uploadCaptchaId = null;
        let images = [];
        let sortOrder = "newest";
        let selectedCategory = "all";
        let uploadCategory = "general";

        function renderCaptcha(containerId, action, onToken) {
            const container = document.querySelector(containerId);
            if (!turnstileSiteKey) {
                container.innerHTML = '<span class="captcha-widget-message">CAPTCHA is not configured. Submissions are disabled.</span>';
                return null;
            }
            if (!window.turnstile) {
                container.innerHTML = '<span class="captcha-widget-message">CAPTCHA could not load. Refresh to try again.</span>';
                return null;
            }
            return window.turnstile.render(container, {
                sitekey: turnstileSiteKey,
                action,
                callback: onToken,
                "expired-callback": () => onToken(""),
                "error-callback": () => onToken("")
            });
        }

        function relativeTime(date) {
            const seconds = Math.round((date.getTime() - Date.now()) / 1000);
            const units = [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]];
            const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
            for (const [size, unit] of units) {
                if (Math.abs(seconds) >= size) return formatter.format(Math.round(seconds / size), unit);
            }
            return "just now";
        }

        function createVoteControls(mediaId, initialScore, onRemoved) {
            const controls = document.createElement("div");
            controls.className = "vote-controls";
            const upvote = document.createElement("button");
            upvote.type = "button";
            upvote.className = "vote-button";
            upvote.textContent = "👍";
            upvote.setAttribute("aria-label", "Thumbs up");
            const score = document.createElement("span");
            score.className = "vote-score";
            score.textContent = initialScore;
            score.setAttribute("aria-label", `Score ${initialScore}`);
            const downvote = document.createElement("button");
            downvote.type = "button";
            downvote.className = "vote-button";
            downvote.textContent = "👎";
            downvote.setAttribute("aria-label", "Thumbs down");
            let voteCompleted = false;

            async function submitVote(delta) {
                upvote.disabled = true;
                downvote.disabled = true;
                try {
                    const response = await fetch(`/api/media/${mediaId}/vote`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ delta })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || "Could not record vote.");
                    if (result.removed) {
                        voteCompleted = true;
                        onRemoved();
                        return;
                    }
                    score.textContent = result.score;
                    score.setAttribute("aria-label", `Score ${result.score}`);
                    voteCompleted = true;
                    if (result.alreadyVoted) {
                        const message = imageRoute
                            ? document.querySelector("#comment-status")
                            : document.querySelector("#status");
                        if (message) message.textContent = "You have already voted on this upload.";
                    }
                } catch (error) {
                    const message = imageRoute
                        ? document.querySelector("#comment-status")
                        : document.querySelector("#status");
                    if (message) message.textContent = error.message;
                } finally {
                    if (controls.isConnected && !voteCompleted) {
                        upvote.disabled = false;
                        downvote.disabled = false;
                    }
                }
            }

            upvote.addEventListener("click", () => submitVote(1));
            downvote.addEventListener("click", () => submitVote(-1));
            controls.append(upvote, score, downvote);
            return controls;
        }

        if (imageRoute) {
            const imageId = imageRoute[1];
            const image = document.querySelector("#detail-image");
            const commentForm = document.querySelector("#comment-form");
            const commentInput = document.querySelector("#comment-text");
            const commentList = document.querySelector("#comment-list");
            const commentCount = document.querySelector("#comment-count");
            const commentStatus = document.querySelector("#comment-status");
            const commentSubmit = commentForm.querySelector("button[type='submit']");
            const commentsUrl = `/api/images/${imageId}/comments`;
            const reportDialog = document.querySelector("#report-dialog");
            const reportForm = document.querySelector("#report-form");
            const reportStatus = document.querySelector("#report-status");
            const reportSubmit = document.querySelector("#submit-report");
            const reportFeedback = document.querySelector("#report-feedback");
            let commentCaptchaToken = "";
            commentSubmit.disabled = true;
            const commentCaptchaId = renderCaptcha("#comment-captcha", "comment", (token) => {
                commentCaptchaToken = token;
                commentSubmit.disabled = !token;
            });
            if (commentCaptchaId === null) commentSubmit.disabled = true;

            document.querySelector("#open-report").addEventListener("click", () => {
                reportStatus.textContent = "";
                reportDialog.showModal();
            });
            document.querySelector("#cancel-report").addEventListener("click", () => reportDialog.close());
            reportForm.addEventListener("submit", async (event) => {
                event.preventDefault();
                if (!reportForm.reportValidity()) return;
                reportSubmit.disabled = true;
                reportStatus.textContent = "Submitting report...";
                reportFeedback.textContent = "";
                try {
                    const response = await fetch(`/api/media/${imageId}/reports`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            reason: reportForm.elements.category.value,
                            description: reportForm.elements.description.value.trim()
                        })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || "Could not submit this report.");
                    reportForm.reset();
                    reportDialog.close();
                    reportFeedback.textContent = "Thank you. Your report was submitted anonymously.";
                } catch (error) {
                    reportStatus.textContent = error.message || "Could not submit this report.";
                } finally {
                    reportSubmit.disabled = false;
                }
            });

            galleryView.hidden = true;
            detailView.hidden = false;
            document.querySelector("#about").hidden = true;
            const video = document.querySelector("#detail-video");

            fetch(`/api/media/${imageId}`).then(async (response) => {
                const media = await response.json();
                if (!response.ok) throw new Error(media.error || "Could not load this media.");
                if (media.kind === "video") {
                    video.src = media.url;
                    video.hidden = false;
                    document.querySelector(".photo-caption strong").textContent = "Shared video";
                    document.querySelector(".photo-caption span").textContent = "WebM video";
                } else {
                    image.src = media.url;
                    image.hidden = false;
                }
                document.querySelector(".photo-caption").append(createVoteControls(imageId, media.votes, () => {
                    window.location.assign("/#gallery");
                }));
            }).catch((error) => {
                commentStatus.textContent = error.message;
            });

            function renderComments(comments) {
                commentList.replaceChildren();
                commentCount.textContent = `${comments.length} ${comments.length === 1 ? "comment" : "comments"}`;
                if (!comments.length) {
                    const empty = document.createElement("p");
                    empty.className = "comment-empty";
                    empty.textContent = "No comments yet. Start the conversation.";
                    commentList.append(empty);
                }

                for (const comment of comments) {
                    const item = document.createElement("article");
                    item.className = "comment-item";
                    const meta = document.createElement("div");
                    meta.className = "comment-meta";
                    const author = document.createElement("span");
                    author.className = "comment-author";
                    const avatar = document.createElement("span");
                    avatar.className = "anonymous-mark";
                    avatar.setAttribute("aria-hidden", "true");
                    avatar.textContent = "?";
                    author.append(avatar, document.createTextNode("Anonymous"));
                    const time = document.createElement("time");
                    time.dateTime = comment.createdAt;
                    time.textContent = relativeTime(new Date(comment.createdAt));
                    meta.append(author, time);
                    const text = document.createElement("p");
                    text.className = "comment-text";
                    text.textContent = comment.text;
                    item.append(meta, text);
                    commentList.append(item);
                }
                commentList.setAttribute("aria-busy", "false");
            }

            async function loadComments() {
                commentList.setAttribute("aria-busy", "true");
                try {
                    const response = await fetch(commentsUrl);
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || "Could not load comments.");
                    renderComments(result);
                } catch (error) {
                    commentCount.textContent = "Unavailable";
                    commentList.textContent = error.message;
                    commentList.setAttribute("aria-busy", "false");
                }
            }

            commentForm.addEventListener("submit", async (event) => {
                event.preventDefault();
                const text = commentInput.value.trim();
                if (!text) return;
                if (!commentCaptchaToken) {
                    commentStatus.textContent = "Complete the CAPTCHA before posting.";
                    return;
                }
                commentSubmit.disabled = true;
                commentStatus.textContent = "Posting...";
                try {
                    const response = await fetch(commentsUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ text, captchaToken: commentCaptchaToken })
                    });
                    const result = await response.json();
                    if (!response.ok) throw new Error(result.error || "Could not post your comment.");
                    commentInput.value = "";
                    commentStatus.textContent = "Your comment has been posted.";
                    await loadComments();
                } catch (error) {
                    commentStatus.textContent = error.message || "Could not post your comment.";
                } finally {
                    commentCaptchaToken = "";
                    if (commentCaptchaId !== null && window.turnstile) {
                        window.turnstile.reset(commentCaptchaId);
                    } else {
                        commentSubmit.disabled = true;
                    }
                }
            });

            loadComments();
        } else {

        uploadCaptchaId = renderCaptcha("#upload-captcha", "upload", (token) => {
            uploadCaptchaToken = token;
            submitButton.disabled = !token;
        });
        if (uploadCaptchaId === null) submitButton.disabled = true;

        function setCategory(categoryId, categoryName) {
            selectedCategory = categoryId;
            if (categoryId !== "all") {
                uploadCategory = categoryId;
                uploadDestination.textContent = `Posting to ${categoryName} · AVIF or WebM · 20 MB max`;
                document.querySelector("#gallery-heading").textContent = `${categoryName} feed`;
            } else {
                uploadCategory = "general";
                uploadDestination.textContent = "Posting to General · AVIF or WebM · 20 MB max";
                document.querySelector("#gallery-heading").textContent = "Community feed";
            }
            categoryList.querySelectorAll("[data-category]").forEach((button) => {
                button.setAttribute("aria-pressed", String(button.dataset.category === categoryId));
            });
            loadGallery();
        }

        async function loadCategories() {
            const response = await fetch("/api/categories");
            const categories = await response.json();
            if (!response.ok) throw new Error(categories.error || "Could not load categories.");

            categoryList.querySelectorAll("[data-category]:not([data-category='all'])").forEach((button) => button.remove());
            const allCountValue = categories.reduce((sum, category) => sum + category.count, 0);
            allCategoryCount.textContent = allCountValue;

            for (const category of categories) {
                const button = document.createElement("button");
                button.className = "category-button";
                button.type = "button";
                button.dataset.category = category.id;
                button.setAttribute("aria-pressed", String(selectedCategory === category.id));
                const name = document.createElement("span");
                name.textContent = category.name;
                const countLabel = document.createElement("span");
                countLabel.className = "category-count";
                countLabel.textContent = `${category.count}/${category.limit}`;
                button.append(name, countLabel);
                button.addEventListener("click", () => setCategory(category.id, category.name));
                categoryList.append(button);
            }
            categoryList.setAttribute("aria-busy", "false");
            categoryList.querySelector("[data-category='all']").onclick = () => setCategory("all", "General");
        }

        function renderGallery() {
            grid.querySelectorAll(".image-tile").forEach((tile) => tile.remove());
            const sortedImages = [...images].sort((first, second) => {
                const difference = new Date(first.createdAt) - new Date(second.createdAt);
                return sortOrder === "newest" ? -difference : difference;
            });

            count.textContent = `${images.length} ${images.length === 1 ? "item" : "items"} shared`;
            total.textContent = images.length ? `${images.length} ${images.length === 1 ? "post" : "posts"}` : "";
            emptyState.hidden = images.length > 0;

            sortedImages.forEach((image, index) => {
                const tile = document.createElement("article");
                tile.className = "image-tile";
                tile.style.animationDelay = `${Math.min(index * 35, 280)}ms`;

                const link = document.createElement("a");
                link.className = "image-link";
                const imageId = image.id;
                link.href = `/image/${imageId}`;
                link.setAttribute("aria-label", `View ${image.kind} and comments, ${relativeTime(new Date(image.createdAt))}`);

                if (image.kind === "video") {
                    const video = document.createElement("video");
                    video.src = image.url;
                    video.muted = true;
                    video.playsInline = true;
                    video.preload = "metadata";
                    video.autoplay = true;
                    video.loop = true;
                    video.setAttribute("aria-label", "Community shared video preview");
                    const badge = document.createElement("span");
                    badge.className = "video-badge";
                    badge.textContent = "VIDEO";
                    link.append(video, badge);
                } else {
                    const img = document.createElement("img");
                    img.src = image.url;
                    img.alt = "Community shared image";
                    img.loading = "lazy";
                    img.decoding = "async";
                    link.append(img);
                }

                const meta = document.createElement("div");
                meta.className = "tile-meta";
                const label = document.createElement("span");
                label.className = "tile-label";
                label.textContent = image.kind === "video" ? "Shared video" : "Shared image";
                const time = document.createElement("time");
                time.className = "tile-time";
                time.dateTime = image.createdAt;
                time.textContent = relativeTime(new Date(image.createdAt));
                meta.append(label, createVoteControls(image.id, image.votes, async () => {
                    await loadCategories();
                    await loadGallery();
                }), time);
                tile.append(link, meta);
                grid.append(tile);
            });
            grid.setAttribute("aria-busy", "false");
        }

        async function loadGallery() {
            grid.setAttribute("aria-busy", "true");
            try {
                const response = await fetch(`/api/media?category=${encodeURIComponent(selectedCategory)}`);
                if (!response.ok) throw new Error("Could not load the image feed.");
                images = await response.json();
                renderGallery();
            } catch (error) {
                status.textContent = error.message;
                grid.setAttribute("aria-busy", "false");
            }
        }

        fileInput.addEventListener("change", () => {
            const file = fileInput.files[0];
            fileName.textContent = file ? file.name : "Drop an image or video here, or choose one from your device";
            submitButton.hidden = !file;
            submitButton.disabled = !uploadCaptchaToken;
        });

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (!fileInput.files[0]) return;
            if (!uploadCaptchaToken) {
                status.textContent = "Complete the CAPTCHA before uploading.";
                return;
            }
            status.textContent = `Converting your ${fileInput.files[0].type.startsWith("video/") ? "video" : "image"}...`;
            submitButton.disabled = true;

            try {
                const response = await fetch("/upload", {
                    method: "POST",
                    headers: {
                        "X-Media-Category": uploadCategory,
                        "X-Turnstile-Token": uploadCaptchaToken
                    },
                    body: new FormData(form)
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || "Upload failed.");
                status.textContent = "Your media is in the feed.";
                form.reset();
                fileName.textContent = "Drop an image or video here, or choose one from your device";
                submitButton.hidden = true;
                await loadCategories();
                await loadGallery();
                document.querySelector("#gallery").scrollIntoView({ behavior: "smooth", block: "start" });
            } catch (error) {
                status.textContent = error.message || "Upload failed.";
            } finally {
                uploadCaptchaToken = "";
                if (uploadCaptchaId !== null && window.turnstile) {
                    window.turnstile.reset(uploadCaptchaId);
                } else {
                    submitButton.disabled = true;
                }
            }
        });

        for (const eventName of ["dragenter", "dragover"]) {
            dropZone.addEventListener(eventName, (event) => {
                event.preventDefault();
                dropZone.classList.add("is-dragging");
            });
        }

        for (const eventName of ["dragleave", "drop"]) {
            dropZone.addEventListener(eventName, (event) => {
                event.preventDefault();
                dropZone.classList.remove("is-dragging");
            });
        }

        dropZone.addEventListener("drop", (event) => {
            const [file] = event.dataTransfer.files;
            if (!file || (!file.type.startsWith("image/") && !file.type.startsWith("video/"))) {
                status.textContent = "Please drop an image or video file.";
                return;
            }
            const transfer = new DataTransfer();
            transfer.items.add(file);
            fileInput.files = transfer.files;
            fileInput.dispatchEvent(new Event("change"));
        });

        document.querySelectorAll("[data-sort]").forEach((button) => {
            button.addEventListener("click", () => {
                sortOrder = button.dataset.sort;
                document.querySelectorAll("[data-sort]").forEach((tab) => {
                    tab.setAttribute("aria-pressed", String(tab === button));
                });
                renderGallery();
            });
        });

        loadCategories().then(loadGallery).catch((error) => {
            status.textContent = error.message;
            categoryList.setAttribute("aria-busy", "false");
        });
        }
