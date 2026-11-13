<?php
define('ABSPATH', '/');
define('PTR_ROOM_ORIGIN', 'http://127.0.0.1:3031');
define('PTR_ROOM_SECRETS', array('testroom' => 'fixture-room-secret-at-least-32-characters'));
$store = array();
function add_shortcode($name, $callback) {}
function add_action($name, $callback) {}
function is_user_logged_in() { return true; }
function shortcode_atts($defaults, $attributes, $tag) { return array_merge($defaults, $attributes); }
function get_current_user_id() { return 7; }
function set_transient($key, $value, $ttl) { global $store; $store[$key] = $value; }
function get_transient($key) { global $store; return $store[$key] ?? false; }
function delete_transient($key) { global $store; unset($store[$key]); }
function wp_create_nonce($action) { return hash('sha256', $action); }
function wp_verify_nonce($nonce, $action) { return hash_equals(wp_create_nonce($action), $nonce); }
function add_query_arg($args, $url) { return $url . '?' . http_build_query($args); }
function admin_url($path) { return 'https://wordpress.example.test/' . $path; }
function esc_url($value) { return htmlspecialchars($value, ENT_QUOTES); }
function esc_html($value) { return htmlspecialchars($value, ENT_QUOTES); }
function sanitize_text_field($value) { return $value; }
function wp_unslash($value) { return $value; }
function wp_parse_url($value) { return parse_url($value); }
function wp_get_current_user() { return (object) array('user_email' => 'member@example.test', 'display_name' => 'Test Member', 'roles' => array('subscriber')); }
function is_email($value) { return filter_var($value, FILTER_VALIDATE_EMAIL); }
function apply_filters($name, $value, ...$args) { return $value; }
function wp_json_encode($value) { return json_encode($value); }
function nocache_headers() {}
function wp_redirect($url, $status, $source) { echo $url; }
function wp_die($message, $title = '', $args = array()) { throw new Exception($message); }
require '/workspace/integrations/wordpress/protradingroom.php';
$html = ptr_room_shortcode(array('room' => 'testroom', 'link_text' => 'Enter Room', 'mode' => 'urlv3'));
if (strpos($html, PTR_ROOM_SECRETS['testroom']) !== false || strpos($html, 'eyJ') !== false) { throw new Exception('Secret or token appeared in the page.'); }
preg_match('/href="([^"]+)"/', $html, $match);
parse_str(parse_url(html_entity_decode($match[1]), PHP_URL_QUERY), $_GET);
ptr_room_login();
