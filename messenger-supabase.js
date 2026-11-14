/* Messenger Pro - Supabase cloud adapter.
   Uses Supabase Auth, Postgres, Storage and Realtime. No service-role key is used. */
(function () {
  const SUPABASE_URL = "https://bfboehvgrivanmrfqquw.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_BKQ_gEGu54VUztykzIIfEQ_2IMIoMb_";
  const MEDIA_BUCKET = "messenger-media";
  let sb, authUser, liveChannel;

  const $ = (id) => document.getElementById(id);
  const fail = (error) => { console.error("[Messenger/Supabase]", error); alert(error?.message || "Something went wrong. Please try again."); };
  const defaultAvatar = (seed) => "https://api.dicebear.com/7.x/avataaars/svg?seed=" + encodeURIComponent(seed || "Messenger");
  const escapeText = (value) => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  const isDataUrl = (value) => typeof value === "string" && value.startsWith("data:image/");
  const uid = () => authUser?.id;

  async function uploadImage(dataUrl) {
    if (!isDataUrl(dataUrl)) return null;
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
    const path = uid() + "/" + crypto.randomUUID() + "." + ext;
    const { error } = await sb.storage.from(MEDIA_BUCKET).upload(path, blob, {
      contentType: blob.type || "image/jpeg", upsert: false
    });
    if (error) throw error;
    return path;
  }

  async function signedImage(path) {
    if (!path) return "";
    const { data, error } = await sb.storage.from(MEDIA_BUCKET).createSignedUrl(path, 3600);
    if (error) { console.warn("Could not sign Messenger media", error); return ""; }
    return data.signedUrl;
  }

  async function loadMessengerData() {
    const [pRes, fRes, gRes, gmRes, mRes, muteRes] = await Promise.all([
      sb.from("messenger_profiles").select("*").order("created_at"),
      sb.from("messenger_friendships").select("*"),
      sb.from("messenger_groups").select("*").order("created_at"),
      sb.from("messenger_group_members").select("*"),
      sb.from("messenger_messages").select("*").order("created_at"),
      sb.from("messenger_mutes").select("*").eq("user_id", uid())
    ]);
    for (const r of [pRes, fRes, gRes, gmRes, mRes, muteRes]) if (r.error) throw r.error;

    const profileRows = pRes.data || [];
    const signedProfiles = await Promise.all(profileRows.map(async p => ({
      id: p.id, username: p.username, name: p.display_name || p.username,
      bio: p.bio || "", avatar: await signedImage(p.avatar_path) || defaultAvatar(p.username),
      avatarPath: p.avatar_path || null,
      galleryPaths: p.gallery_paths || ["", "", ""],
      gallery: await Promise.all((p.gallery_paths || ["", "", ""]).map(signedImage)),
      friends: [], mutedChats: []
    })));
    const profileMap = new Map(signedProfiles.map(p => [p.id, p]));
    (fRes.data || []).forEach(f => {
      const a = profileMap.get(f.user_id), b = profileMap.get(f.friend_id);
      if (a && !a.friends.includes(f.friend_id)) a.friends.push(f.friend_id);
      if (b && !b.friends.includes(f.user_id)) b.friends.push(f.user_id);
    });
    const muteKeys = (muteRes.data || []).map(m => m.chat_key);
    const me = profileMap.get(uid());
    if (me) me.mutedChats = muteKeys;

    const memberRows = gmRes.data || [];
    const mappedGroups = (gRes.data || []).map(g => ({
      id: g.id, name: g.name, avatar: defaultAvatar(g.name),
      members: Array.from({length: Math.max(g.member_count || 1, memberRows.filter(m => m.group_id === g.id).length)}, (_, i) => i === 0 ? uid() : "member-" + i)
    }));
    mappedGroups.forEach(g => { if (!g.members.includes(uid())) g.members.push(uid()); });

    const mappedMessages = await Promise.all((mRes.data || []).map(async m => ({
      id: m.id, senderId: m.sender_id,
      receiverId: m.group_id || m.recipient_id,
      isGroup: !!m.group_id, text: m.body || "",
      image: await signedImage(m.image_path), imagePath: m.image_path || null,
      time: new Date(m.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}),
      deleted: !!m.deleted, createdAt: m.created_at
    })));

    users = signedProfiles;
    groups = mappedGroups;
    messages = mappedMessages;
    currentUser = profileMap.get(uid()) || null;
    currentUserId = uid();
    if (!currentUser) throw new Error("Your Messenger profile was not found. Please sign out and register again.");
    window.renderLists();
    if (activeChat) window.renderMessages();
  }

  async function loadActiveMessages() {
    if (!activeChat || !uid()) return;
    let query = sb.from("messenger_messages").select("*").order("created_at");
    if (activeChat.type === "group") query = query.eq("group_id", activeChat.id);
    else query = query.or(
      "and(sender_id.eq." + uid() + ",recipient_id.eq." + activeChat.id + ")," +
      "and(sender_id.eq." + activeChat.id + ",recipient_id.eq." + uid() + ")"
    );
    const { data, error } = await query;
    if (error) throw error;
    messages = messages.filter(m => !(activeChat.type === "group"
      ? m.isGroup && m.receiverId === activeChat.id
      : !m.isGroup && ((m.senderId === uid() && m.receiverId === activeChat.id) || (m.senderId === activeChat.id && m.receiverId === uid()))));
    const fresh = await Promise.all((data || []).map(async m => ({
      id:m.id, senderId:m.sender_id, receiverId:m.group_id || m.recipient_id,
      isGroup:!!m.group_id, text:m.body || "", image:await signedImage(m.image_path),
      imagePath:m.image_path || null,
      time:new Date(m.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}),
      deleted:!!m.deleted, createdAt:m.created_at
    })));
    messages.push(...fresh);
    messages.sort((a,b)=>new Date(a.createdAt||0)-new Date(b.createdAt||0));
    window.renderMessages();
    window.renderLists();
  }

  async function initAfterAuth(user) {
    authUser = user;
    if (liveChannel) { await sb.removeChannel(liveChannel); liveChannel = null; }
    const { data: profile, error: profileError } = await sb.from("messenger_profiles").select("id").eq("id", user.id).maybeSingle();
    if (profileError) throw profileError;
    if (!profile) {
      const emailName = (user.email || "user").split("@")[0].replace(/[^a-z0-9_]/gi,"").toLowerCase() || "user";
      const { error } = await sb.from("messenger_profiles").insert({
        id:user.id, username:emailName + "_" + user.id.slice(0,6),
        display_name:user.user_metadata?.display_name || emailName
      });
      if (error) throw error;
    }
    if (user.app_metadata?.messenger_role === "admin") {
      window.initAdminDashboard();
      return;
    }
    await loadMessengerData();
    $("auth-screen").style.display = "none";
    $("admin-screen").style.display = "none";
    $("app-screen").style.display = "block";
    $("current-user-avatar").src = currentUser.avatar;
    $("current-user-name").innerText = currentUser.name;
    window.renderAppLogo();
    window.updateThemeIcon();
    window.requestNotificationPermission();
    window.renderLists();
    liveChannel = sb.channel("messenger-live-" + user.id)
      .on("postgres_changes", {event:"*", schema:"public", table:"messenger_messages"}, () => {
        loadActiveMessages().catch(fail);
        if (!activeChat) loadMessengerData().catch(fail);
      })
      .subscribe();
  }

  function installOverrides() {
    window.saveData = function () { /* Cloud mutations are written by the handlers below. */ };
    window.handleAuth = async function () {
      const email = $("auth-username").value.trim().toLowerCase();
      const password = $("auth-password").value;
      if (!email || !password) return alert("Please enter your email and password.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return alert("Please use a valid email address. Messenger accounts now use Supabase Auth.");
      const button = $("auth-submit-btn");
      button.disabled = true; button.textContent = "Please wait...";
      try {
        if (isRegisterMode) {
          const name = $("reg-name").value.trim();
          if (!name) throw new Error("Please enter your full name.");
          const rawAvatar = $("reg-avatar-preview").src;
          const { data, error } = await sb.auth.signUp({
            email, password,
            options: { data: { app:"messenger", role:"messenger", display_name:name, username:email.split("@")[0] } }
          });
          if (error) throw error;
          if (!data.session) {
            alert("Registration received. Please verify your email, then log in.");
            window.toggleAuthMode();
            return;
          }
          authUser = data.user;
          const avatarPath = isDataUrl(rawAvatar) ? await uploadImage(rawAvatar) : null;
          if (avatarPath) {
            const { error: upErr } = await sb.from("messenger_profiles").update({avatar_path:avatarPath, display_name:name}).eq("id",data.user.id);
            if (upErr) throw upErr;
          } else {
            const { error: upErr } = await sb.from("messenger_profiles").update({display_name:name}).eq("id",data.user.id);
            if (upErr) throw upErr;
          }
          await initAfterAuth(data.user);
        } else {
          const { data, error } = await sb.auth.signInWithPassword({email,password});
          if (error) throw error;
          await initAfterAuth(data.user);
        }
      } catch (e) { fail(e); }
      finally { button.disabled = false; button.textContent = isRegisterMode ? "Sign Up" : "Log In"; }
    };

    window.logout = async function () {
      try { if (sb) await sb.auth.signOut(); } catch (e) { console.warn(e); }
      if (liveChannel) { await sb.removeChannel(liveChannel); liveChannel = null; }
      authUser = null; currentUserId = null; currentUser = null; activeChat = null;
      users = []; groups = []; messages = [];
      $("app-screen").style.display = "none";
      $("admin-screen").style.display = "none";
      $("auth-screen").style.display = "flex";
      $("auth-password").value = "";
    };

    window.initApp = async function () {
      const { data, error } = await sb.auth.getUser();
      if (error || !data.user) { $("auth-screen").style.display = "flex"; return; }
      await initAfterAuth(data.user);
    };

    window.initAdminDashboard = async function () {
      $("auth-screen").style.display = "none";
      $("app-screen").style.display = "none";
      $("admin-screen").style.display = "block";
      window.renderAppLogo();
      await window.renderAdminUsersTable();
    };

    window.renderAdminUsersTable = async function () {
      const tbody = $("admin-users-tbody");
      if (!tbody) return;
      tbody.innerHTML = "<tr><td colspan='4'>Loading accounts...</td></tr>";
      const {data,error} = await sb.from("messenger_profiles").select("id,username,display_name,created_at").order("created_at");
      if (error) { tbody.innerHTML = "<tr><td colspan='4'>Unable to load accounts.</td></tr>"; return fail(error); }
      const head = document.querySelector("#admin-screen thead tr");
      if (head) head.innerHTML = "<th>Account / Name</th><th>Username</th><th>Created</th><th>Security</th>";
      tbody.innerHTML = (data || []).map(p => "<tr><td><b>"+escapeText(p.display_name)+"</b><div style='font-size:11px;color:var(--text-secondary)'>ID: "+escapeText(p.id)+"</div></td><td>@"+escapeText(p.username)+"</td><td>"+new Date(p.created_at).toLocaleDateString()+"</td><td><span class='pass-pill'>Password protected by Supabase Auth</span></td></tr>").join("") || "<tr><td colspan='4'>No accounts registered yet.</td></tr>";
    };
    window.openAdminChangePassModal = function () {
      alert("Passwords are securely managed by Supabase Auth and cannot be viewed or changed by reading database records. Use Supabase Auth password reset.");
    };
    window.saveAdminPasswordChange = function () { window.closeModal("admin-pass-modal"); };

    window.addFriend = async function (friendId) {
      if (!friendId || friendId === uid() || currentUser.friends.includes(friendId)) return;
      const {error} = await sb.from("messenger_friendships").insert({user_id:uid(),friend_id:friendId});
      if (error && error.code !== "23505") return fail(error);
      const me = users.find(u=>u.id===uid()), other=users.find(u=>u.id===friendId);
      if (me && !me.friends.includes(friendId)) me.friends.push(friendId);
      if (other && !other.friends.includes(uid())) other.friends.push(uid());
      window.renderLists();
    };

    window.openChat = async function (type,id) {
      if (type === "user" && !currentUser.friends.includes(id)) await window.addFriend(id);
      activeChat = {type,id};
      $("empty-chat-state").style.display = "none";
      $("active-chat-box").style.display = "flex";
      $("messenger-layout").classList.add("mobile-chat-open");
      if (type === "user") {
        const friend=users.find(u=>u.id===id); if (!friend) return;
        $("chat-target-avatar").src=friend.avatar; $("chat-target-name").innerText=friend.name;
        $("chat-target-sub").innerText="Messenger • Cloud chat";
      } else {
        const group=groups.find(g=>g.id===id); if (!group) return;
        $("chat-target-avatar").src=group.avatar; $("chat-target-name").innerText=group.name;
        $("chat-target-sub").innerText=group.members.length+" members";
      }
      window.updateMuteButtonUI();
      window.renderLists();
      await loadActiveMessages().catch(fail);
    };

    window.pushMessage = async function ({text,image}) {
      if (!activeChat || !uid()) return;
      try {
        const imagePath = image ? await uploadImage(image) : null;
        const payload = {sender_id:uid(), body:text || "", image_path:imagePath};
        if (activeChat.type === "group") payload.group_id=activeChat.id;
        else payload.recipient_id=activeChat.id;
        const {data,error}=await sb.from("messenger_messages").insert(payload).select("*").single();
        if (error) throw error;
        const mapped = {id:data.id,senderId:data.sender_id,receiverId:data.group_id||data.recipient_id,isGroup:!!data.group_id,text:data.body,image:await signedImage(data.image_path),imagePath:data.image_path,time:new Date(data.created_at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),deleted:false,createdAt:data.created_at};
        messages.push(mapped); window.renderMessages(); window.renderLists();
      } catch(e) { fail(e); }
    };

    window.sendPhotoMessage = async function (event) {
      const file=event.target.files?.[0]; if(!file||!activeChat) return;
      if (!file.type.startsWith("image/")) { alert("Please choose an image."); event.target.value=""; return; }
      const reader=new FileReader();
      reader.onload=()=>window.pushMessage({text:"",image:reader.result});
      reader.readAsDataURL(file); event.target.value="";
    };

    window.deleteMessage = async function (messageId) {
      const msg=messages.find(m=>m.id===messageId);
      if(!msg||msg.senderId!==uid()||msg.deleted) return;
      if(!confirm("Delete this message?")) return;
      const {error}=await sb.from("messenger_messages").update({deleted:true,body:"",image_path:null}).eq("id",messageId).eq("sender_id",uid());
      if(error) return fail(error);
      msg.deleted=true; msg.text=""; msg.image=null; window.renderMessages(); window.renderLists();
    };

    window.toggleMuteChat = async function () {
      if(!activeChat) return;
      const key=activeChat.id, isMuted=currentUser.mutedChats.includes(key);
      const result=isMuted
        ? await sb.from("messenger_mutes").delete().eq("user_id",uid()).eq("chat_key",key)
        : await sb.from("messenger_mutes").insert({user_id:uid(),chat_key:key});
      if(result.error && result.error.code!=="23505") return fail(result.error);
      if(isMuted) currentUser.mutedChats=currentUser.mutedChats.filter(x=>x!==key);
      else currentUser.mutedChats.push(key);
      window.updateMuteButtonUI(); window.renderLists();
    };

    window.createGroupChat = async function () {
      const groupName=$("group-name-input").value.trim();
      const checked=Array.from(document.querySelectorAll(".group-member-cb:checked")).map(cb=>cb.value);
      if(!groupName) return alert("Please enter a group name.");
      if(!checked.length) return alert("Select at least 1 friend.");
      try {
        const memberIds=[...new Set([uid(),...checked])];
        const {data:group,error}=await sb.from("messenger_groups").insert({name:groupName,created_by:uid(),member_count:memberIds.length}).select("*").single();
        if(error) throw error;
        const {error:memberError}=await sb.from("messenger_group_members").insert(memberIds.map(user_id=>({group_id:group.id,user_id})));
        if(memberError) throw memberError;
        await loadMessengerData();
        window.closeModal("group-modal"); window.switchTab("groups");
        await window.openChat("group",group.id);
      } catch(e) { fail(e); }
    };

    window.saveProfileChanges = async function () {
      const newName=$("edit-name-input").value.trim(), newBio=$("edit-bio-input").value.trim();
      if(!newName) return alert("Name cannot be empty.");
      try {
        const avatarSrc=$("profile-modal-avatar").src;
        let avatarPath=currentUser.avatarPath;
        if(isDataUrl(avatarSrc)) avatarPath=await uploadImage(avatarSrc);
        const galleryPaths=[];
        for(let i=0;i<3;i++) {
          const item=tempGallery[i] || "";
          galleryPaths.push(isDataUrl(item) ? await uploadImage(item) : (currentUser.galleryPaths?.[i] || ""));
        }
        const {error}=await sb.from("messenger_profiles").update({
          display_name:newName,bio:newBio,avatar_path:avatarPath,gallery_paths:galleryPaths
        }).eq("id",uid());
        if(error) throw error;
        await loadMessengerData();
        $("current-user-name").innerText=currentUser.name;
        $("current-user-avatar").src=currentUser.avatar;
        window.closeModal("profile-modal"); window.renderLists();
      } catch(e) { fail(e); }
    };
  }

  document.addEventListener("DOMContentLoaded", async function () {
    try {
      if (!window.supabase?.createClient) throw new Error("Supabase client library did not load. Refresh the page and try again.");
      sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      window.messengerSupabase = sb;
      installOverrides();
      const {data,error}=await sb.auth.getSession();
      if(error) throw error;
      if(data.session?.user) await initAfterAuth(data.session.user);
      else {
        currentUserId=null; currentUser=null; users=[]; groups=[]; messages=[];
        $("auth-screen").style.display="flex";
        $("app-screen").style.display="none";
        $("admin-screen").style.display="none";
        $("auth-username").setAttribute("type","email");
        $("auth-username").setAttribute("autocomplete","email");
        $("auth-username").setAttribute("placeholder","Email address");
        const demo=document.querySelector("#auth-screen p[style*='margin-top: 14px']");
        if(demo) demo.remove();
      }
    } catch(e) { console.error(e); alert("Messenger cloud connection failed: "+(e.message||e)); }
  });
})();