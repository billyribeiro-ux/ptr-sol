<?php
/**
 * Plugin Name: ProTradingRoom JWT Link
 * Description: Reconstructed server-side WordPress integration for room JWT sign-in.
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

function ptr_room_base64url($value) {
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function ptr_room_shortcode($attributes) {
    if (!is_user_logged_in()) {
        return '';
    }
    $attributes = shortcode_atts(array('room' => '', 'key' => '', 'link_text' => 'Enter Room', 'mode' => 'urlv3'), $attributes, 'protradingroom');
    $room = (string) $attributes['room'];
    $keys = defined('PTR_ROOM_SECRETS') && is_array(PTR_ROOM_SECRETS) ? PTR_ROOM_SECRETS : array();
    // Prefer a wp-config.php mapping so page content never contains the secret.
    $secret = isset($keys[$room]) ? $keys[$room] : $attributes['key'];
    if (!preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $room) || !is_string($secret) || strlen($secret) < 32 || $attributes['mode'] !== 'urlv3') {
        return '';
    }
    $ticket = bin2hex(random_bytes(24));
    set_transient('ptr_room_' . $ticket, array('user' => get_current_user_id(), 'room' => $room, 'secret' => $secret), 120);
    $url = add_query_arg(array('action' => 'ptr_room_login', 'ticket' => $ticket, '_wpnonce' => wp_create_nonce('ptr_room_' . $ticket)), admin_url('admin-post.php'));
    return '<a href="' . esc_url($url) . '">' . esc_html($attributes['link_text']) . '</a>';
}
add_shortcode('protradingroom', 'ptr_room_shortcode');

function ptr_room_login() {
    $ticket = isset($_GET['ticket']) ? sanitize_text_field(wp_unslash($_GET['ticket'])) : '';
    if (!is_user_logged_in() || !preg_match('/^[a-f0-9]{48}$/D', $ticket) || !isset($_GET['_wpnonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_GET['_wpnonce'])), 'ptr_room_' . $ticket)) {
        wp_die('The sign-in link is invalid or expired.', '', array('response' => 403));
    }
    $record = get_transient('ptr_room_' . $ticket);
    if (!is_array($record) || (int) $record['user'] !== get_current_user_id()) {
        wp_die('The sign-in link is invalid or expired.', '', array('response' => 403));
    }
    delete_transient('ptr_room_' . $ticket);
    $origin = defined('PTR_ROOM_ORIGIN') ? rtrim((string) PTR_ROOM_ORIGIN, '/') : '';
    $parts = wp_parse_url($origin);
    $local = isset($parts['host']) && in_array(strtolower($parts['host']), array('localhost', '127.0.0.1', '::1'), true);
    if (!$parts || empty($parts['host']) || empty($parts['scheme']) || ($parts['scheme'] !== 'https' && !($parts['scheme'] === 'http' && $local)) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment']) || (!empty($parts['path']) && $parts['path'] !== '/')) {
        wp_die('The room origin is not configured.', '', array('response' => 503));
    }
    $user = wp_get_current_user();
    if (!is_email($user->user_email)) {
        wp_die('A valid account email is required.', '', array('response' => 403));
    }
    $now = time();
    $claims = array('email' => $user->user_email, 'name' => $user->display_name, 'roomID' => $record['room'], 'iat' => $now, 'exp' => $now + 120);
    // Integrators can map trusted server-side membership plugins and WP roles.
    foreach (array('memberships', 'products', 'permissions') as $field) {
        $value = apply_filters('ptr_room_' . $field, $field === 'permissions' ? $user->roles : array(), $user, $record['room']);
        $claims[$field] = is_array($value) ? array_values(array_filter($value, 'is_string')) : array();
    }
    if (defined('PTR_ROOM_SECURITY_TOKENS') && is_array(PTR_ROOM_SECURITY_TOKENS) && isset(PTR_ROOM_SECURITY_TOKENS[$record['room']])) {
        $claims['secTok'] = (string) PTR_ROOM_SECURITY_TOKENS[$record['room']];
    }
    if (defined('PTR_ROOM_AUDIENCES') && is_array(PTR_ROOM_AUDIENCES) && isset(PTR_ROOM_AUDIENCES[$record['room']])) {
        $claims['aud'] = (string) PTR_ROOM_AUDIENCES[$record['room']];
    }
    $header = ptr_room_base64url(wp_json_encode(array('alg' => 'HS256', 'typ' => 'JWT')));
    $payload = ptr_room_base64url(wp_json_encode($claims));
    $signature = ptr_room_base64url(hash_hmac('sha256', $header . '.' . $payload, $record['secret'], true));
    $url = add_query_arg(array('sessID' => $record['room'], 'jwt' => $header . '.' . $payload . '.' . $signature, 'sl' => '1'), $origin . '/users/v1/ssoJWT');
    nocache_headers();
    header('Referrer-Policy: no-referrer');
    wp_redirect($url, 302, 'ProTradingRoom');
    exit;
}
add_action('admin_post_ptr_room_login', 'ptr_room_login');
