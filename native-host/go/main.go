// SubVault cross-platform native messaging sync host.
//
// Protocol: Chrome native messaging (4-byte little-endian length + UTF-8 JSON).
// Commands: ping, status, pull, publish, webdav-status, webdav-pull,
// webdav-push. Emits {"type":"change"} when another process publishes a new
// revision. WebDAV is proxied here so the extension never opens a socket.
package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	maxMessage = 32 * 1024 * 1024
	stateFile  = "state.json"
)

type state map[string]any

var (
	dataDir    string
	statePath  string
	outputMu   sync.Mutex
	stateMu    sync.Mutex
	lastSeen   int64 = -1
	lastSeenMu sync.Mutex
)

func main() {
	dataDir = resolveDataDir()
	statePath = filepath.Join(dataDir, stateFile)
	_ = os.MkdirAll(dataDir, 0o755)
	if s := readState(statePath); s != nil {
		lastSeen = revision(s)
	}
	go pollChanges()
	run()
}

func resolveDataDir() string {
	if custom := os.Getenv("SUBVAULT_SYNC_DIR"); custom != "" {
		return custom
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		probe := filepath.Join(dir, ".write-test")
		if err := os.WriteFile(probe, []byte("ok"), 0o644); err == nil {
			_ = os.Remove(probe)
			return filepath.Join(dir, "data")
		}
	}
	if config, err := os.UserConfigDir(); err == nil {
		return filepath.Join(config, "SubVaultSync")
	}
	return filepath.Join(os.TempDir(), "SubVaultSync")
}

func readState(path string) state {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var parsed state
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil
	}
	if _, ok := parsed["revision"]; !ok {
		parsed["revision"] = float64(0)
	}
	if _, ok := parsed["updatedAt"]; !ok {
		parsed["updatedAt"] = float64(0)
	}
	return parsed
}

func revision(s state) int64 {
	if s == nil {
		return 0
	}
	switch value := s["revision"].(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case json.Number:
		n, _ := value.Int64()
		return n
	}
	return 0
}

func updatedAt(s state) int64 {
	if s == nil {
		return 0
	}
	switch value := s["updatedAt"].(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case json.Number:
		n, _ := value.Int64()
		return n
	}
	return 0
}

func writeState(path string, s state) error {
	raw, err := json.Marshal(s)
	if err != nil {
		return err
	}
	temp := path + ".tmp"
	if err := os.WriteFile(temp, raw, 0o644); err != nil {
		return err
	}
	if _, err := os.Stat(path); err == nil {
		_ = os.Remove(path + ".bak")
		_ = os.Rename(path, path+".bak")
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(path)
		err = os.Rename(temp, path)
	}
	_ = os.Remove(path + ".bak")
	return err
}

// acquireLock serialises state writes across host processes. A stale lock file
// older than ten seconds is removed so a crashed host cannot block sync.
func acquireLock(path string) (func(), error) {
	lockPath := path + ".lock"
	deadline := time.Now().Add(5 * time.Second)
	for {
		file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = file.WriteString(time.Now().UTC().Format(time.RFC3339Nano))
			_ = file.Close()
			return func() { _ = os.Remove(lockPath) }, nil
		}
		if os.IsPermission(err) {
			return nil, errors.New("无法写入同步目录（权限被拒绝）：" + path)
		}
		if info, statErr := os.Stat(lockPath); statErr == nil && time.Since(info.ModTime()) > 10*time.Second {
			_ = os.Remove(lockPath)
			continue
		}
		if time.Now().After(deadline) {
			return nil, errors.New("同步宿主正忙，请稍后重试")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func vaultKeyFrom(message map[string]any) string {
	raw, _ := message["vaultId"].(string)
	raw = strings.ToLower(strings.TrimSpace(raw))
	var builder strings.Builder
	for _, char := range raw {
		if (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-' || char == '_' {
			builder.WriteRune(char)
		}
		if builder.Len() >= 64 {
			break
		}
	}
	return builder.String()
}

func statePathFor(key string) string {
	if key == "" || key == "default" {
		return statePath
	}
	return filepath.Join(dataDir, "vault-"+key+".json")
}

func status(message map[string]any) map[string]any {
	path := statePathFor(vaultKeyFrom(message))
	s := readState(path)
	return map[string]any{
		"ok":        true,
		"exists":    s != nil,
		"revision":  revision(s),
		"updatedAt": updatedAt(s),
		"path":      path,
	}
}

func pull(message map[string]any) map[string]any {
	path := statePathFor(vaultKeyFrom(message))
	s := readState(path)
	if s == nil {
		return map[string]any{"ok": true, "exists": false}
	}
	return map[string]any{
		"ok":        true,
		"exists":    true,
		"revision":  revision(s),
		"updatedAt": updatedAt(s),
		"vault":     s["vault"],
		"settings":  s["settings"],
		"ignores":   defaultIgnores(s),
	}
}

func defaultIgnores(s state) any {
	if s == nil || s["ignores"] == nil {
		return []any{}
	}
	return s["ignores"]
}

func publish(message map[string]any) map[string]any {
	vault, ok := message["vault"]
	if !ok || vault == nil {
		return errorResponse("缺少加密密码库数据")
	}
	baseRevision := 0.0
	if value, ok := message["baseRevision"].(float64); ok {
		baseRevision = value
	}
	path := statePathFor(vaultKeyFrom(message))
	unlock, err := acquireLock(path)
	if err != nil {
		return errorResponse(err.Error())
	}
	defer unlock()

	current := revision(readState(path))
	if int64(baseRevision) != current {
		s := readState(path)
		return map[string]any{
			"ok":        false,
			"conflict":  true,
			"revision":  current,
			"updatedAt": updatedAt(s),
		}
	}
	next := readState(path)
	if next == nil {
		next = state{}
	}
	next["revision"] = float64(current + 1)
	next["updatedAt"] = float64(time.Now().UnixMilli())
	next["vault"] = vault
	next["settings"] = message["settings"]
	next["ignores"] = defaultIgnoresValue(message["ignores"])
	if err := writeState(path, next); err != nil {
		return errorResponse(err.Error())
	}
	return map[string]any{
		"ok":        true,
		"revision":  current + 1,
		"updatedAt": next["updatedAt"],
	}
}

func defaultIgnoresValue(value any) any {
	if value == nil {
		return []any{}
	}
	return value
}

// ---------------------------------------------------------------------------
// Optional WebDAV transport
//
// The extension sends the encrypted vault through this local process. The host
// performs the HTTPS request, keeps credentials only for the duration of one
// command, and never writes them to disk. A fixed path avoids exposing a
// general-purpose WebDAV client: <base>/subvault/state.json.
// ---------------------------------------------------------------------------

const webdavRelativePath = "/subvault/state.json"

type webdavConfig struct {
	URL      string
	Username string
	Password string
}

type webdavEnvelope struct {
	Revision  int64           `json:"revision"`
	UpdatedAt int64           `json:"updatedAt"`
	Vault     json.RawMessage `json:"vault"`
	Settings  json.RawMessage `json:"settings"`
	Ignores   json.RawMessage `json:"ignores"`
}

var webdavClient = &http.Client{
	Timeout: 20 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("WebDAV 重定向次数过多")
		}
		if req.URL.Scheme != "https" && !(req.URL.Scheme == "http" && isLoopbackHost(req.URL.Hostname())) {
			return errors.New("WebDAV 重定向到了非 HTTPS 地址")
		}
		return nil
	},
}

func isLoopbackHost(host string) bool {
	host = strings.TrimSpace(host)
	if host == "localhost" {
		return true
	}
	if parsed := net.ParseIP(host); parsed != nil {
		return parsed.IsLoopback()
	}
	return false
}

func webdavRelativeFor(key string) string {
	if key == "" || key == "default" {
		return webdavRelativePath
	}
	return "/subvault/" + key + "/state.json"
}

func webdavEndpoint(raw string, key string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("请填写 WebDAV 地址")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "", errors.New("WebDAV 地址格式不正确")
	}
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopbackHost(parsed.Hostname())) {
		return "", errors.New("WebDAV 地址必须使用 HTTPS（本机测试可用 http://127.0.0.1）")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + webdavRelativeFor(key)
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func webdavConfigFrom(message map[string]any) (webdavConfig, string, error) {
	raw, _ := message["config"].(map[string]any)
	cfg := webdavConfig{
		URL:      messageText(raw["url"]),
		Username: messageText(raw["username"]),
		Password: messageText(raw["password"]),
	}
	endpoint, err := webdavEndpoint(cfg.URL, vaultKeyFrom(message))
	if err != nil {
		return cfg, "", err
	}
	if len(cfg.Username) > 256 || len(cfg.Password) > 1024 {
		return cfg, "", errors.New("WebDAV 凭据过长")
	}
	return cfg, endpoint, nil
}

func messageText(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func webdavRequest(method, endpoint string, cfg webdavConfig, body []byte, headers map[string]string) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		return nil, err
	}
	if cfg.Username != "" || cfg.Password != "" {
		req.SetBasicAuth(cfg.Username, cfg.Password)
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	return webdavClient.Do(req)
}

func webdavFailure(resp *http.Response) string {
	snippet := ""
	if resp != nil {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		snippet = strings.TrimSpace(string(raw))
	}
	if resp == nil {
		return "WebDAV 请求失败"
	}
	switch resp.StatusCode {
	case 401, 403:
		return "WebDAV 认证失败，请检查用户名和密码"
	case 404:
		return "WebDAV 路径不存在（可能尚未创建目录）"
	case 412, 409:
		return "" // handled as conflict by the caller
	}
	if snippet != "" {
		return fmt.Sprintf("WebDAV 返回 HTTP %d：%s", resp.StatusCode, snippet)
	}
	return fmt.Sprintf("WebDAV 返回 HTTP %d", resp.StatusCode)
}

func parseWebdavEnvelope(raw []byte) (webdavEnvelope, error) {
	var envelope webdavEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return envelope, errors.New("WebDAV 上的 SubVault 数据格式不正确")
	}
	if len(envelope.Vault) == 0 || string(envelope.Vault) == "null" {
		return envelope, errors.New("WebDAV 上的 SubVault 数据缺少密码库")
	}
	return envelope, nil
}

func readWebdavEnvelope(endpoint string, cfg webdavConfig, etag string) (webdavEnvelope, string, bool, int, error) {
	headers := map[string]string{"Accept": "application/json"}
	if etag != "" {
		headers["If-None-Match"] = etag
	}
	resp, err := webdavRequest(http.MethodGet, endpoint, cfg, nil, headers)
	if err != nil {
		return webdavEnvelope{}, "", false, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		return webdavEnvelope{}, strings.TrimSpace(etag), true, http.StatusNotModified, nil
	}
	if resp.StatusCode == http.StatusNotFound {
		return webdavEnvelope{}, "", false, http.StatusNotFound, nil
	}
	if resp.StatusCode != http.StatusOK {
		return webdavEnvelope{}, "", false, resp.StatusCode, errors.New(webdavFailure(resp))
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxMessage))
	if err != nil {
		return webdavEnvelope{}, "", false, resp.StatusCode, err
	}
	envelope, err := parseWebdavEnvelope(raw)
	if err != nil {
		return webdavEnvelope{}, "", false, resp.StatusCode, err
	}
	return envelope, strings.TrimSpace(resp.Header.Get("ETag")), false, http.StatusOK, nil
}

func webdavStatus(message map[string]any) map[string]any {
	cfg, endpoint, err := webdavConfigFrom(message)
	if err != nil {
		return errorResponse(err.Error())
	}
	etag := messageText(message["etag"])
	envelope, nextEtag, notModified, statusCode, err := readWebdavEnvelope(endpoint, cfg, etag)
	if err != nil {
		return errorResponse(err.Error())
	}
	if notModified {
		return map[string]any{
			"ok": true, "exists": true, "notModified": true,
			"etag": nextEtag, "status": statusCode,
		}
	}
	if statusCode == http.StatusNotFound {
		return map[string]any{"ok": true, "exists": false, "etag": ""}
	}
	return map[string]any{
		"ok": true, "exists": true, "notModified": false,
		"revision": envelope.Revision, "updatedAt": envelope.UpdatedAt,
		"etag": nextEtag, "path": endpoint,
	}
}

func webdavPull(message map[string]any) map[string]any {
	cfg, endpoint, err := webdavConfigFrom(message)
	if err != nil {
		return errorResponse(err.Error())
	}
	envelope, etag, notModified, statusCode, err := readWebdavEnvelope(endpoint, cfg, "")
	if err != nil {
		return errorResponse(err.Error())
	}
	if notModified || statusCode == http.StatusNotFound || len(envelope.Vault) == 0 {
		return map[string]any{"ok": true, "exists": false}
	}
	return map[string]any{
		"ok": true, "exists": true,
		"revision": envelope.Revision, "updatedAt": envelope.UpdatedAt,
		"vault": envelope.Vault, "settings": envelope.Settings,
		"ignores": envelope.Ignores, "etag": etag, "path": endpoint,
	}
}

func webdavPush(message map[string]any) map[string]any {
	cfg, endpoint, err := webdavConfigFrom(message)
	if err != nil {
		return errorResponse(err.Error())
	}
	vault := message["vault"]
	if vault == nil {
		return errorResponse("缺少加密密码库数据")
	}
	baseRevision := int64(0)
	if value, ok := message["baseRevision"].(float64); ok {
		baseRevision = int64(value)
	}
	etag := messageText(message["etag"])
	envelope := map[string]any{
		"revision":  baseRevision + 1,
		"updatedAt": time.Now().UnixMilli(),
		"vault":     vault,
		"settings":  message["settings"],
		"ignores":   defaultIgnoresValue(message["ignores"]),
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		return errorResponse(err.Error())
	}
	headers := map[string]string{"Content-Type": "application/json"}
	if etag != "" {
		headers["If-Match"] = etag
	} else {
		headers["If-None-Match"] = "*"
	}
	resp, err := webdavRequest(http.MethodPut, endpoint, cfg, body, headers)
	if err != nil {
		return errorResponse(err.Error())
	}
	if resp.StatusCode == http.StatusConflict && etag == "" {
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if mkErr := webdavMkcol(endpoint, cfg); mkErr == nil {
			resp, err = webdavRequest(http.MethodPut, endpoint, cfg, body, headers)
			if err != nil {
				return errorResponse(err.Error())
			}
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusPreconditionFailed || resp.StatusCode == http.StatusConflict {
		return map[string]any{"ok": false, "conflict": true, "status": resp.StatusCode}
	}
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusNoContent {
		return errorResponse(webdavFailure(resp))
	}
	return map[string]any{
		"ok": true, "revision": baseRevision + 1,
		"updatedAt": envelope["updatedAt"],
		"etag":      strings.TrimSpace(resp.Header.Get("ETag")),
	}
}

func webdavMkcol(endpoint string, cfg webdavConfig) error {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return err
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/state.json")
	if parsed.Path == "" {
		return nil
	}
	targets := []string{parsed.String()}
	if index := strings.LastIndex(parsed.Path, "/subvault/"); index >= 0 {
		root := *parsed
		root.Path = parsed.Path[:index] + "/subvault"
		targets = []string{root.String(), parsed.String()}
	}
	for _, target := range targets {
		resp, err := webdavRequest("MKCOL", target, cfg, nil, nil)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode == http.StatusCreated || resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusMethodNotAllowed {
			continue
		}
		if resp.StatusCode == http.StatusConflict {
			continue
		}
		return errors.New(webdavFailure(resp))
	}
	return nil
}

func errorResponse(text string) map[string]any {
	return map[string]any{"ok": false, "error": text}
}

func handle(message map[string]any) map[string]any {
	switch messageType(message["type"]) {
	case "ping":
		return map[string]any{"ok": true, "pong": true}
	case "status":
		return status(message)
	case "pull":
		return pull(message)
	case "publish":
		return publish(message)
	case "webdav-status":
		return webdavStatus(message)
	case "webdav-pull":
		return webdavPull(message)
	case "webdav-push":
		return webdavPush(message)
	case "device-status", "device-protect", "device-unlock", "device-forget":
		return map[string]any{
			"ok":        false,
			"supported": false,
			"exists":    false,
			"error":     "设备快速解锁仅支持 Windows 同步宿主（DPAPI）",
		}
	default:
		return errorResponse("未知同步命令: " + messageType(message["type"]))
	}
}

func messageType(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func run() {
	reader := bufio.NewReaderSize(os.Stdin, 64*1024)
	stdout := os.Stdout
	for {
		var header [4]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return
		}
		length := int(binary.LittleEndian.Uint32(header[:]))
		if length <= 0 || length > maxMessage {
			return
		}
		payload := make([]byte, length)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return
		}
		var message map[string]any
		if err := json.Unmarshal(payload, &message); err != nil {
			writeMessage(errorResponse(err.Error()))
			continue
		}
		response := handle(message)
		if id, ok := message["id"]; ok {
			response["id"] = id
		}
		writeMessage(response)
		_ = stdout.Sync()
	}
}

func writeMessage(message map[string]any) {
	payload, err := json.Marshal(message)
	if err != nil {
		return
	}
	header := make([]byte, 4)
	binary.LittleEndian.PutUint32(header, uint32(len(payload)))
	outputMu.Lock()
	defer outputMu.Unlock()
	_, _ = os.Stdout.Write(header)
	_, _ = os.Stdout.Write(payload)
	_ = os.Stdout.Sync()
}

func pollChanges() {
	ticker := time.NewTicker(900 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		state := readState(statePath)
		rev := revision(state)
		lastSeenMu.Lock()
		changed := rev > 0 && rev != lastSeen
		if changed {
			lastSeen = rev
		}
		lastSeenMu.Unlock()
		if changed {
			writeMessage(map[string]any{
				"type":      "change",
				"revision":  rev,
				"updatedAt": updatedAt(state),
			})
		}
	}
}

var _ = runtime.GOOS
