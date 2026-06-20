<?php
// starts lines with lengths not started
// don't know how this happens
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: *');
header('Access-Control-Allow-Methods: GET');
header('Content-Type: application/json');

define("include_shows",1);
require_once "pl_config1.php";
error_reporting(E_ALL);
ini_set('display_errors',"1");

if(!defined("sh_sun"))
	define("sh_sun",0x01);

if(!defined("log_stuff"))
	define("log_stuff",1);

if(log_stuff)
{
	error_reporting(E_ALL & ~E_DEPRECATED);
	ini_set('display_errors',"1");
	$log_name = log_dir . "/" . "nudoapi.out";
	$db->set_log($log_name,"w");
}

$db->write_log("max_mem=" . ini_get("memory_limit") . "\n");

global $now;
$now = time();

$ret_val = '0';

function get_signal_plistid()
{
	global $db;

	$sql = "select cf_plistid from " . $db->archive_tables("cf_table");
	$sql .= " where (cf_info & " . (cf_signal | cf_scheduled) . ") = " . (cf_signal | cf_scheduled);
	$row = $db->archive_data($sql,$num);
	return($row["cf_plistid"]);
}

function get_special_sched($stdte,$endte,$plistid = '')
{
	global $db;

	if(empty($plistid))
		$plistid = $db->confessor_plistid();

	$sql = "select sh_altid,sh_name,ph_date,ph_shlen,ph_shour,ph_day from " . $db->confessor_tables("sh_table,ph_table");
	$sql .= " where sh_altid=ph_shaltid";
	$sql .= " and ph_date >= $stdte";
	$sql .= " and ph_date <= $endte";
	$sql .= " order by ph_date";
	$ary = $db->confessor_data($sql,$num,true);

	return($ary);
}

function get_special_sched_weeks($wks,$endte = 0,$plistid = '')
{
	global $db;
	global $now;

	if(empty($endte))
		$endte = $now;

	$sundte = get_sunday($endte);
	$dtary = getdate($sundte);
	$stdte = mktime(0,0,0,$dtary["mon"],$dtary["mday"] - (7 * $wks),$dtary["year"]);
	$ary = get_special_sched($stdte,$endte,$plistid);

	return($ary);
}


function get_pubfile($idkey,$def_time)
{
	global $db;
	$big_ary = array();
	$really_big_ary = array();

	$sql = "select * from " . $db->confessor_tables("pf_table");
	$sql .= " where pf_idkey='" . $idkey . "'";
	$sql .= " and pf_schedtime=$def_time";
	$sql .= " and not pf_info & " . (pf_subhost);
	$sql .= " order by pf_num";
	$ary = $db->confessor_data($sql,$num,true); 
	if(!empty($ary))
	{
		$count = 0;
		foreach($ary as $key => $val)
		{
			foreach($val as $pkey => $pval)
			{
				switch($pkey)
				{
				case "pf_host":
				case "pf_gname":
				case "pf_gtopic":
				case "pf_gurl":
				case "pf_notes":
					$really_big_ary[$count][$pkey] = $pval;
					break;
				case "pf_issue1":
				case "pf_issue2":
				case "pf_issue3":
					if(!empty($pval))
					{
						$sql = "select pi_issue from $pi_table";
						$sql .= " where pi_id=$pval";
						$pi_row = $db->confessor_data($sql,$num);

						if(!empty($pi_row))
						{
							$really_big_ary[$count][$pkey] = $pi_row["pi_issue"];
						}
					}
					else
					{
						$really_big_ary[$count][$pkey] = '';
					}
					break;
				default:
					break;
				}
			}
			$count++;
		}
	}
	return($really_big_ary);
}

function get_filnams($idkey,$num = 0)
{
	global $db;
	global $gl_row;
	$now = time();

	$big_ary = array();
	$really_big_ary = array();

	if(empty($num))
		$num = 5;

	$sql = "select * from " . $db->archive_tables("fn_table");
	$sql .= " where idkey='" . $idkey . "'";
	$sql .= " and expires >= $now";
	$sql .= " order by def_time desc";
	$sql .= " limit $num";
	$ary = $db->archive_data($sql,$num,true);
	$count = 0;
	foreach($ary as $key => $val)
	{
		$really_big_ary[$count] = array();
		$pub_ary = get_pubfile($val["idkey"],$val["def_time"]);
		$really_big_ary[$count]["pubfile"] = $pub_ary;

		foreach($val as $fkey => $fval)
		{
			switch($fkey)
			{
			case "idkey":
			case "title":
			case "category":
			case "producer":
			case "link":
			case "facebook":
			case "twitter":
			case "tumblr":
			case "txt":
			case "days":
				$really_big_ary[$count][$fkey] = $fval;
				break;
			case "expires":
				$really_big_ary[$count]["eday"] = date("F j, Y",$fval);
				$really_big_ary[$count][$fkey] = $fval;
				break;
			case "lsecs":
				$really_big_ary[$count][$fkey] = $fval;
				$really_big_ary[$count]["length"] = time_from_secs($fval);
				break;
			case "def_time":
				$really_big_ary[$count]["day"] = date("l",$fval);
				$really_big_ary[$count]["date"] = date("F j, Y",$fval);
				$really_big_ary[$count]["time"] = date("g:i A",$fval);
				$really_big_ary[$count][$fkey] = $fval;
				break;
			case "abspath":
				 $file = home_url . str_replace(home_dir,"",$fval);
				if(empty($val["expires"]) || $now <= $val["expires"])
					$really_big_ary[$count]["mp3"] = $file;
				else
					$really_big_ary[$count]["mp3"] = 'expired';
				break;
			case "id":
				break;
			case "info":
				if($fval & (filn_download|filn_pod))
					$really_big_ary[$count]["type"] = "Talk";
				else
					$really_big_ary[$count]["type"] = "Music";
				break;
			default:
				break;
			}
		}
		$count++;
	}
	return($really_big_ary);
}

function get_filnam($deftime,$plistid = my_plistid)
{
	global $db;
	global $now;

	$file_name = '';

	$sql = "select abspath from " . $db->archive_tables("fn_table");
	$sql .= " where def_time=$deftime";
	$sql .= " and plistid='$plistid'";
	$sql .= " and expires >= $now";
	$row = $db->archive_data($sql,$num);
	if(!empty($row["abspath"]))
		$file_name = mp3_url . "/" . basename($row["abspath"]);

	return($file_name);
}

function get_filnam_list($deftime_list)
{
	global $db;
	global $now;

	$file_name_ary = [];

	$sql = "select abspath from " . $db->archive_tables("fn_table");
	$sql .= " where def_time in ($deftime_list)";
	$sql .= " and expires > $now";
	$sql .= " order by def_time desc";
	$ary = $db->archive_data($sql,$num,true);
	if(!empty($ary))
	{
		foreach($ary as $row)
			$file_name_ary[] = mp3_url . "/" . basename($row["abspath"]);
	}
	return($file_name_ary);
}

function get_nowplaying_show()
{
        global $db;
        global $gl_row;
	global $now;

        $row = array();

        $sql = "select * from " . $db->confessor_tables("sh_table,ph_table");
        $sql .= " left join " . $db->confessor_tables("pf_table");
        $sql .= " on pf_phid=ph_id";
        $sql .= " and pf_info & " . (pf_subhost);
        $sql .= " where ph_date < $now";
        $sql .= " and sh_id=ph_shid";
        $sql .= " order by ph_date desc limit 1";
        $ary = $db->confessor_data($sql,$num);
        if(!empty($ary))
        {
                $row = $ary;
                if(!empty($row["pf_host"]))
                        $row["sh_djname"] = $row["ph_host"];
        }
        $sql = "select ph_date from " . $db->confessor_tables("ph_table");
        $sql .= " where ph_date > " . $row["ph_date"];
        $sql .= " order by ph_date asc limit 1";
        $ary = $db->confessor_data($sql,$num);
        if(!empty($ary))
        {
                $row["next"] = $ary["ph_date"] - $now;
        }
        return($row);
}

function get_nowplaying_short()
{
        global $db;
        global $gl_row;
		global $now;

        $row = array();

        $sql = "select sh_name,sh_djname,pf_host,ph_date,ph_shlen from " . $db->confessor_tables("sh_table,ph_table");
        $sql .= " left join " . $db->confessor_tables("pf_table");
        $sql .= " on pf_idkey=ph_shaltid";
        $sql .= " and pf_info & " . (pf_subhost);
        $sql .= " where ph_date < $now";
        $sql .= " and sh_altid=ph_shaltid";
        $sql .= " order by ph_date desc limit 1";
        $ary = $db->confessor_data($sql,$num);
$db->write_log("sql=$sql - er=" . $db->last_error() . "\n");
        if(!empty($ary))
        {
			$ary["day"] = date("l",$ary["ph_date"]);
			$ary["date"] = date("F j",$ary["ph_date"]);
			$ary["year"] = date("Y",$ary["ph_date"]);
			$ary["time"] = date("g:i",$ary["ph_date"]);
			$ary["ampm"] = date("A",$ary["ph_date"]);
			if(!empty($ary["pf_host"]))
			{
				$ary["sh_djname"] = $ary["pf_host"];
			}
			$ary["pf_host"] = '';
			unset($ary["pf_host"]);
			$row = $ary;
        }
        $sql = "select ph_date,sh_name,sh_djname from " . $db->confessor_tables("ph_table,sh_table");
        $sql .= " left join " . $db->confessor_tables("pf_table");
        $sql .= " on pf_idkey=sh_altid";
        $sql .= " and pf_info & " . (pf_subhost);
		$sql .= " where sh_altid=ph_shaltid";
        $sql .= " and ph_date >= " . intval($ary["ph_date"] + $ary["ph_shlen"]);
        $sql .= " order by ph_date asc limit 1";
        $nxt = $db->confessor_data($sql,$num);
$db->write_log("sql=$sql - er=" . $db->last_error() . "\n");
        if(!empty($nxt))
        {
			$nxt["day"] = date("l",$nxt["ph_date"]);
			$nxt["date"] = date("F j",$nxt["ph_date"]);
			$nxt["year"] = date("Y",$nxt["ph_date"]);
			$nxt["time"] = date("g:i",$nxt["ph_date"]);
			$nxt["ampm"] = date("A",$nxt["ph_date"]);
			if(!empty($nxt["pf_host"]))
			{
				$nxt["sh_djname"] = $ary["pf_host"];
			}
			$nxt["pf_host"] = '';
			unset($nxt["pf_host"]);
			$row["next"] = $nxt;
        }
		else
			$row["next"] = '';

        return($row);
}

function _get_midnight($day = -1)
{
	global $db;

	$tim = time();
	$dt_ary = localtime($tim,true);
	$wday = $dt_ary["tm_wday"];			// today's wday
	$nu_mday = $dt_ary["tm_mday"];
	if($day > -1)
	{
		$d = $day - $wday;
		if($d < 0)
			$d += 7;
		$nu_mday += $d;
	}
			
$db->write_log("day=$day - nu_mday=$nu_mday = dt_ary=" . print_r($dt_ary,true) . "\n");
	$is_dst = $dt_ary["tm_isdst"];
	$midnight = mktime(0,0,0,$dt_ary["tm_mon"] + 1,$nu_mday,$dt_ary["tm_year"] + 1900);
$db->write_log("midnight=$midnight - " . date("r",$midnight) . "\n");
	$dt_ary1 = localtime($midnight,true);
$db->write_log("dt_ary1=" . print_r($dt_ary1,true) . "\n");
	$was_dst = $dt_ary1["tm_isdst"];
	if($is_dst && !$was_dst)					// spring forward
	{
		$midnight = mktime(1,0,0,$dt_ary["tm_mon"] + 1,$dt_ary["tm_mday"],$dt_ary["tm_year"] + 1900);
	}
	else if($was_dst && !$is_dst)
	{
		$midnight = mktime(23,0,0,$dt_ary["tm_mon"] + 1,$dt_ary["tm_mday"],$dt_ary["tm_year"] + 1900);
	}
	return($midnight);
}

function get_start_time($secs,$day = -1)
{
	global $db;

	$midnight = _get_midnight($day);
	$dt_ary = localtime($midnight,true);
$db->write_log("dt_ary=" . print_r($dt_ary,true) . "\n");
	$start_time = mktime(0,0,$secs,$dt_ary["tm_mon"] + 1,$dt_ary["tm_mday"],$dt_ary["tm_year"] + 1900);
$db->write_log("start_time=$start_time - " . date("r",$start_time) . "\n");
	return($start_time);
}

function print_show($id,$name,$dj,$secs,$len,$info)
{
	if($info & sh_gone)
		$style = ' style="color:red;display:none;background-color:#bbbbbb;" name="gone" ';
	else
		$style = '';

	$time_str = time_from_secs($secs);
	$day_str = show_days($info);
	$end_time_str = time_from_secs($secs + $len);

	if(empty($dj))
		$dj = '&nbsp;';

	$str = <<<EOF
	<tr $style>
		<td align="left" valign="middle" class="list_data"><a href="sh_form.php?id=$id">$name</a></td>
		<td align="left" valign="middle" class="list_data">$dj</td>
		<td align="right" valign="middle" class="list_data">$time_str</td>
		<td align="right" valign="middle" class="list_data">$end_time_str</td>
		<td align="left" valign="middle" class="list_data">$day_str</td>
	</tr>
EOF;
	print $str . "\n";
}

function get_day($num)
{
	global $db;

	$day_mask = sh_sun << $num;

	$sql = "select * from " . $db->confessor_tables("sh_table");
	$sql .= " where (sh_info & " . $day_mask . ")";
	$sql .= " and not (sh_info & " . (sh_gone) . ")";
	$sql .= " order by sh_shour";
	$ary = $db->confessor_data($sql,$num,true);

	return($ary);
}

function get_one_day($num)
{
	global $gl_row;
	global $sh_big_day_list;

	$big_ary = array();

	$ary = get_day($num);
	$day_name = $sh_big_day_list[$num];
	if(!empty($ary))
	{
		$count = 0;
		foreach($ary as $row)
		{
			$big_ary[$count] = array();
			foreach($row as $row_key => $row_val)
			{
				switch($row_key)
				{
				case "sh_id":
				case "sh_days":
					break;
				case "sh_altid":
				case "sh_name":
				case "sh_desc":
				case "sh_url":
				case "sh_facebook":
				case "sh_twitter":
				case "sh_tumblr":
				case "sh_djname":
				case "sh_email":
				case "sh_memsysid":
					$big_ary[$count][$row_key] = $row_val;
					break;
				case "sh_photo":
				case "sh_it_photo":
				case "sh_med_photo":
					if(!empty($row_val))
						$big_ary[$count][$row_key] = pix_url . '/' . $row_val;
					else
						$big_ary[$count][$row_key] = '';
					break;
				case "sh_info":
					$big_ary[$count]["day"] = $day_name;
					$big_ary[$count][$row_key] = $row_val;
					$big_ary[$count]["days"] = show_days($row_val);
					if($row_val & sh_talk)
						$big_ary[$count]["type"] = "Talk";
					else
						$big_ary[$count]["type"] = "Music";
				break;
					break;
				case "sh_shour":
					$big_ary[$count]["starts"] = ampm_time_from_secs($row_val);
					$big_ary[$count][$row_key] = $row_val;
					break;
				case "sh_len":
					$big_ary[$count]["ends"] = ampm_time_from_secs($row_val + $row["sh_shour"]);
					$big_ary[$count][$row_key] = $row_val;
					break;
					
				default:
					break;
				}
			}
			$count++;
		}
	}
	return($big_ary);
}

function get_shows_by_day()
{
	global $db;
	global $sh_big_day_list;

	$big_ary = array();

	for($i=0; $i<7; $i++)
	{
$db->write_log("i=$i\n");
		$big_ary[$i] = array();
		$ary = get_day($i);

		if(!empty($ary))
		{
			foreach($ary as $row)
			{
				
				$row["sh_start_time"] = get_start_time($row["sh_shour"],$i);
				$big_ary[$i][] = $row;
			}
		}
	}
	return($big_ary);
}

function get_shows_by_time()
{
	global $db;
	global $sh_day_mask;

	$sql = "select * from " . $db->confessor_tables("sh_table");
	$sql .= " where not info & " . (sh_gone);
	$sql .= " order by sh_shour";
	$sql .= ",(sh_info & " . sh_day_mask . ")";
	$ary = $db->confessor_data($sql,$num,true);

	if($num)
	{
		foreach($ary as $row)
		{
			print_show($row['sh_id'],$row['sh_name'],$row['sh_djname'],$row['sh_shour'],$row["sh_len"],$row['sh_info']);
		}
	}
}

function get_show_ary_by_time()
{
	global $db;
	global $sh_day_mask;

	$sql = "select * from " . $db->confessor_tables("sh_table");
	$sql .= " where not info & " . (sh_gone);
	$sql .= " order by sh_shour";
	$sql .= ",(sh_info & " . sh_day_mask . ")";
	$ary = $db->confessor_data($sql,$num,true);

	return($ary);
}

function get_show_rows()
{
	global $db;
	global $gl_row;

	$big_ary = array();

	for($i=0; $i<7; $i++)
	{
		$big_ary[$i] = array();
		$ary = get_day($i);
		foreach($ary as $row)
			$big_ary[$i][] = $row;
	}
	return($big_ary);
}

function get_gone()
{
	global $db;

	$sql = "select * from " . $db->confessor_tables("sh_table");
	$sql .= " where sh_info & " . (sh_gone);
	$sql .= " order by sh_shour";
	$ary = $db->confessor_data($sql,$num,true);

	return($ary);
}

function cmp_def_times($a,$b)
{
	global $db;

	$a_time = $a['def_time'][0]["dte"];
	$b_time = $b['def_time'][0]["dte"];

//	$ret_val = ($a_time > $b_time ? 1 : $a_time < $b_time ? -1 : 0);
	return($a_time - $b_time);
}

function get_shows($before=1,$after=1)
{
	global $db;
	global $gl_row;
	global $sh_big_day_list;
	global $now;

	$now_ary = getdate($now);
	$start = mktime(0,0,0,$now_ary["mon"],$now_ary["mday"] - ($before * 7),$now_ary["year"]);
    $end = mktime(0,0,0,$now_ary["mon"],$now_ary["mday"] + 7 + ($after * 7),$now_ary["year"]);

	$this_ary = [];
	$big_ary = array();

	$plistid = get_signal_plistid();

	$scheds = new Scheds($db,1,2);

	$this_ary = $scheds->get_all_shows();

	foreach($this_ary as $shaltid => $row)
	{
		if($row["sh_plistid"] == $plistid)
		{
			foreach($row["def_time"] as $def_ary)
			{
				if($def_ary["dte"] > $start && $def_ary["dte"] < $end)
				{
					$ary[$def_ary["dte"]] = $row;
					$ary[$def_ary["dte"]]["def_time"] = $def_ary;
				}
			}
		}
	}
	ksort($ary);
	foreach($ary as $def_time => $row)
	{
		$dtstr = date("n-d H:i",$def_time);
		$db->write_log($dtstr . " - " . $row["sh_name"] . "\n");
	}

	$count = 0;
	foreach($ary as $start => $val)
	{
		$day = date("w",$start);
		foreach($val as $row_key => $row_val)
		{
			switch($row_key)
			{
			case "sh_id":
			case "sh_altid":
			case "sh_name":
			case "sh_desc":
			case "sh_url":
			case "sh_facebook":
			case "sh_twitter":
			case "sh_tumblr":
			case "sh_djname":
			case "sh_email":
			case "sh_start_time":
			case "sh_memsysid":
			case "sh_hour":
				$big_ary[$day][$count][$row_key] = $row_val;
				break;
			case "sh_photo":
			case "sh_med_photo":
			case "sh_it_photo":
				if(!empty($row_val))
					$big_ary[$day][$count][$row_key] = pix_url . '/' . $row_val;
				else
					$big_ary[$day][$count][$row_key] = '';
				break;
			case "sh_info":
				$big_ary[$day][$count][$row_key] = $row_val;
				if($row_val & sh_talk)
					$big_ary[$day][$count]["type"] = "Talk";
				else
					$big_ary[$day][$count]["type"] = "Music";
				break;
			case "def_time":
				$big_ary[$day][$count]["mp3"] = get_filnam($row_val["dte"]);
				$big_ary[$day][$count]["starts"] = date("g:i A",$row_val["dte"]);
				$dtary = getdate($row_val["dte"]);
				$endte = mktime($dtary["hours"],$dtary["minutes"],$dtary["seconds"] + $row_val["len"],$dtary["mon"],$dtary["mday"],$dtary["year"]);
				$big_ary[$day][$count]["ends"] = date("g:i A",$endte);
				$big_ary[$day][$count]["day"] = date("l",$row_val["dte"]);
				$big_ary[$day][$count]["fulldate"] = date("F j, Y",$row_val["dte"]);
				$big_ary[$day][$count]["sh_start_time"] = $row_val["dte"];
				$big_ary[$day][$count]["ph_id"] = $row_val["id"];
				$big_ary[$day][$count]["sh_len"] = $row_val["len"];
				break;
			case "sh_len":
				break;
			default:
				break;
			}
		}
		$count++;
	}
	return($big_ary);
}

function get_next($now = 0)
{
	global $db;
	global $gl_row;

	if(empty($now))
		$now = time();

	$ph_row = array();

	$sql = "select ph_id,ph_info,ph_start," . $db->confessor_tables("sh_table") . ".* from " . $db->confessor_tables("ph_table,sh_table");
	$sql .= " where ph_start >= $now";
	$sql .= " and sh_id=ph_shid";
	$sql .= " and not sh_info & " . (sh_gone);
	$sql .= " order by ph_start asc";
	$sql .= " limit 1";
	$ph_row = $db->confessor_data($sql,$num);

	if(!empty($ph_row))
	{
		$day_name = date("l",$ph_row["ph_start"]);

		foreach($ph_row as $row_key => $row_val)
		{
			switch($row_key)
			{
			case "sh_id":
			case "sh_days":
				break;
			case "sh_altid":
			case "sh_name":
			case "sh_desc":
			case "sh_url":
			case "sh_facebook":
			case "sh_twitter":
			case "sh_tumblr":
			case "sh_djname":
			case "sh_email":
			case "sh_memsysid":
				$big_ary[$row_key] = $row_val;
				break;
			case "sh_photo":
			case "sh_it_photo":
			case "sh_med_photo":
				if(!empty($row_val))
					$big_ary[$row_key] = pix_url . '/' . $row_val;
				else
					$big_ary[$row_key] = '';
				break;
			case "sh_info":
				$big_ary["day"] = $day_name;
				$big_ary["days"] = show_days($row_val);
				$big_ary[$row_key] = $row_val;
				if($row_val & sh_talk)
					$big_ary["type"] = "Talk";
				else
					$big_ary["type"] = "Music";
				break;
			case "sh_shour":
				$start_time = get_start_time($row_val);
				$big_ary["hour"] = date("g:i A",$start_time);
				$big_ary[$row_key] = $row_val;
				break;
			default:
				break;
			}
		}
	}
	return($big_ary);
}

function get_shows_by_alfa()
{
	global $db;

	$big_ary = array();

	$sql = "select * from " . $db->confessor_tables("sh_table");
	$sql .= " where not sh_info & " . (sh_gone);
	$sql .= " order by sh_name";
	$ary = $db->confessor_data($sql,$num,true);

	if($num)
	{
		foreach($ary as $row)
		{
			$time_str = time_from_secs($row["sh_shour"],1);
			$day_str = show_days($row["sh_info"]);
			$end_time_str = time_from_secs($row["sh_shour"] + $row["sh_len"]);
			$start_time = get_start_time($row["sh_shour"]);
			$row['sh_shour'] = $time_str;
			$row['sh_ampm'] = ampm_time_from_secs($row["sh_shour"],1);
			$row['sh_days'] = $day_str;
			$row["sh_big_days"] = show_long_days($row["sh_info"]);
			$row['sh_ends'] = $end_time_str;
			$row['sh_ampm_ends'] = ampm_time_from_secs(intval($row["sh_shour"]) + intval($row["sh_len"]),1);
			$row['sh_start_time'] = $start_time;
			if($row['sh_info'] & sh_talk)
				$row["type"] = "Talk";
			else
				$row["type"] = "Music";

			$big_ary[] = $row;
		}
	}
	return($big_ary);
}

function cmp_stdte($a,$b)
{
	return($a["stdte"] - $b["stdte"]);
}

function get_day_str($ary)
{
	$str = '';
	$days = ["Sundays","Mondays","Tuesdays","Wednesdays","Thursdays","Fridays","Saturdays","Sundays"];
	
	ksort($ary);

	if(count($ary) == 5)
	{
		if($ary[1] == 1 && $ary[5] == 5)
			$str = 'Monday-Friday';
	}
	else
	{
		foreach($ary as $day)
			$str .= $days[$day] . ",";
		$str = rtrim($str,",");
	}
	return($str);
				
}

function get_show_by_key($key)
{
	global $db;
	global $gl_row;
	global $sh_big_day_list;

	$big_ary = [];

	$shdb = new OneShow($db,$key,8,1);

	$row = $shdb->get_show();
$db->write_log("row=" . print_r($row,true) . "\n");

	if(!empty($row))
	{
		foreach($row as $row_key => $row_val)
		{
			switch($row_key)
			{
			case "sh_id":
			case "sh_altid":
			case "sh_name":
			case "sh_desc":
			case "sh_url":
			case "sh_facebook":
			case "sh_twitter":
			case "sh_tumblr":
			case "sh_djname":
			case "sh_email":
			case "sh_start_time":
			case "sh_memsysid":
			case "sh_hour":
				$big_ary[$row_key] = $row_val;
				break;
			case "sh_photo":
			case "sh_med_photo":
			case "sh_it_photo":
				if(!empty($row_val))
					$big_ary[$row_key] = pix_url . '/' . $row_val;
				else
					$big_ary[$row_key] = '';
				break;
			case "sh_info":
				$big_ary[$row_key] = $row_val;
				if($row_val & sh_talk)
					$big_ary["type"] = "Talk";
				else
					$big_ary["type"] = "Music";
				break;
			case "dates":
				$deftime_str = '';
				$day_ary = [];
				foreach($row_val as $def_row)
				{
					$deftime_str .= $def_row["stdte"] . ",";
					$mday = date("w",$def_row["stdte"]);
					$day_ary[$mday] = $mday;
				}
				$deftime_str = rtrim($deftime_str,",");
				$filnam_ary = get_filnam_list($deftime_str);
				$max_mp3s = count($filnam_ary);
				$day_str = get_day_str($day_ary);
				$big_ary["days"] = $day_str;
				$count = 0;
				foreach($row_val as $def_row)
				{
					$big_ary[$row_key][$count]["starts"] = date("g:i A",$def_row["stdte"]);
					$big_ary[$row_key][$count]["ends"] = date("g:i A",$def_row["endte"]);
					$big_ary[$row_key][$count]["day"] = date("l",$def_row["stdte"]);
					$big_ary[$row_key][$count]["fulldate"] = date("F j, Y",$def_row["stdte"]);
					$big_ary[$row_key][$count]["sh_start_time"] = $def_row["stdte"];
					$big_ary[$row_key][$count]["sh_len"] = $def_row["len"];
					if(!empty($filnam_ary[$count]))
						$big_ary[$row_key][$count]["mp3"] = $filnam_ary[$count];
					$count++;
					if($count >= $max_mp3s)
						break;
				}
				break;
			case "sh_len":
				break;
			default:
				break;
			}
		}
	}
	return($big_ary);
}

function get_altids()
{
	global $db;

	$sql = "select sh_altid,sh_name from " . $db->confessor_tables("sh_table");
	$sql .= " where not (sh_info & " . (sh_gone) . ")";
	$sql .= " order by sh_name";
	$ary = $db->confessor_data($sql,$num,true);

	return($ary);
}	

function get_memsys_ids()
{
	global $db;

	$big_ary = array();

	$sql = "select * from " . $db->confessor_tables("sh_table");
	$sql .= " where not (sh_info & " . (sh_gone) . ")";
	$sql .= " order by sh_memsysid";
	$ary = $db->confessor_data($sql,$num,true);

	return($ary);
}

function get_list()
{
	global $db;

	$big_ary = array();

	$sql = "select * from " . $db->confessor_tables("sh_table");
	$sql .= " where not (sh_info & " . (sh_gone) . ")";
	$sql .= " order by sh_name";

	$ary = $db->confessor_data($sql,$num,true);

	if($num)
	{
		foreach($ary as $row)
		{
			$time_str = time_from_secs($row["sh_shour"],1);
			$day_str = show_days($row["sh_info"]);
			$end_time_str = time_from_secs($row["sh_shour"] + $row["sh_len"]);
			$start_time = get_start_time($row["sh_shour"]);
			$row['sh_stime'] = $time_str;
			$row['sh_ampm'] = ampm_time_from_secs($row["sh_shour"],1);
			$row['sh_days'] = $day_str;
			$row["sh_big_days"] = show_long_days($row["sh_info"]);
			$row['sh_ends'] = $end_time_str;
			$row['sh_ampm_ends'] = ampm_time_from_secs($row["sh_shour"] + $row["sh_len"],1);
			$row['sh_start_time'] = $start_time;
			if($row['sh_info'] & sh_talk)
				$row["type"] = "Talk";
			else
				$row["type"] = "Music";

			$big_ary[$row["sh_altid"]] = $row;
		}
	}
	return($big_ary);
}

function get_all_altid_playlists($key)
{
	global $db;

	$big_ary = Array();
	$lil_ary = Array();
	$cur_dte = 0;

	$sql = "select sh_name,sh_desc,sh_shortdesc,sh_djname,ph_date,pl_id,pl_song,pl_artist,pl_album,pl_label,pl_start,pl_len from " . $db->confessor_tables("ph_table");
	$sql .= " left join " . $db->confessor_tables("pl_table") . " on pl_phid=ph_id";
	$sql .= " left join " . $db->confessor_tables("sh_table") . " on sh_altid=ph_shaltid";
	$sql .= " where ph_shaltid='$key'";
	$sql .= " and not (pl_info & " . (pl_talk | pl_not_music_mask) . ")";
	$sql .= " and pl_len > 0";
	$sql .= " and length(pl_artist) > 0";
	$sql .= " order by ph_date desc, pl_sort";
	$ary = $db->confessor_data($sql,$num,true);
	if(!empty($ary))
	{
		foreach($ary as $row)
		{
			if($cur_dte != $row["ph_date"])
			{
				if(!empty($cur_dte))
				{
					$big_ary[$cur_dte] = $lil_ary;
					$big_ary[$cur_dte]["date"] = date("m.d.y",$cur_dte);
					$big_ary[$cur_dte]["time"] = date("H:i",$cur_dte);
					$lil_ary = Array();
				}
				else
				{
					$big_ary["show"] = $row["sh_name"];
					$big_ary["desc"] = $row["sh_desc"];
					$big_ary["shortdesc"] = $row["sh_shortdesc"];
					$big_ary["djname"] = $row["sh_djname"];
				}
				$cur_dte = $row["ph_date"];
			}
			$time = $row["ph_date"] + $row["pl_start"];				// we're ignoring dst
			$time_str = date("H:i",$time);
			$len_str = time_from_secs($row["pl_len"],0);
			$tiny_ary = Array();
			foreach($row as $key => $val)
			{
				if(strpos($key,"pl_") !== false)
					$tiny_ary[$key] = $val;
			}
			$tiny_ary["time"] = $time_str;
			$tiny_ary["len"] = $len_str;
			$lil_ary[] = $tiny_ary;
		}
		$big_ary[$cur_dte] = $lil_ary;
		$big_ary[$cur_dte]["date"] = date("m.d.y",$cur_dte);
		$big_ary[$cur_dte]["time"] = date("H:i",$cur_dte);
	}
	return($big_ary);
}

function get_playlist($type,$phid)
{
	global $db;
	global $gl_row;

	$big_ary = array();

	$sql = "select * from " . $db->confessor_tables("sh_table,ph_table");
	if($type == "date")
		$sql .= " where ph_date=$phid";
	else if($type == "phid")
		$sql .= " where ph_id=$phid";
	$sql .= " and sh_id=ph_shid";
	$sql .= " and not sh_info & " . (sh_talk);
	$row = $db->confessor_data($sql,$num);
	if(!empty($row))
	{
$db->write_log("show: " . $row["sh_name"] . "\n");
		if(empty($row["sh_it_photo"]))
		{
			$big_pix = get_stapix();
		}
		else
		{
//			$big_pix = $gl_row["gl_pixurl"] . "/" . $row["sh_it_photo"];
			$big_pix = pix_url . "/" . $row["sh_it_photo"];
		}

		if(empty($row["sh_med_photo"]))
		{
//			$med_pix = $gl_row["gl_pixurl"] . "/" . $gl_row["gl_stapix"];
			$med_pix = pix_url . "/" . $gl_row["gl_stapix"];
		}
		else
		{
//			$med_pix = $gl_row["gl_pixurl"] . "/" . $row["sh_med_photo"];
			$med_pix = pix_url . "/" . $row["sh_med_photo"];
		}

		if(empty($row["sh_photo"]))
		{
//			$pix = $gl_row["gl_pixurl"] . "/" . $gl_row["gl_stapix"];
			$pix = pix_url . "/" . $gl_row["gl_stapix"];
		}
		else
		{
//			$pix = $gl_row["gl_pixurl"] . "/" . $row["sh_photo"];
			$pix = pix_url . "/" . $row["sh_photo"];
		}
		$ary["show"]["pix"] = $pix;
		$ary["show"]["med_pix"] = $med_pix;
		$ary["show"]["big_pix"] = $big_pix;
		$ary["show"]["date"] = date("l, F j, Y",$row["ph_date"]);
		$ary["show"]["time"] = date("g:i A",$row["ph_date"]);
		$ary["show"]["name"] = $row["sh_name"];
		$ary["show"]["dj"] = $row["sh_djname"];
		$ary["show"]["desc"] = $row["sh_desc"];
		$ary["show"]["short_desc"] = $row["sh_shortdesc"];
		$row["pix"] = $pix;
		$row["big_pix"] = $big_pix;
		$ary["show"]["row"] = $row;
	}
	$sql = "select " . $db->confessor_tables("pl_table") . ".*," . $db->confessor_tables("ph_table") . ".ph_date from " . $db->confessor_tables("pl_table,ph_table");
	if($type == 'date')
		$sql .= " where ph_date=$phid";
	else if($type == "phid")
		$sql .= " where ph_id=$phid";
	$sql .= " and pl_phid=ph_id";
	$sql .= " and pl_start > -1";
	$sql .= " and pl_len > 0";
	$sql .= " and not (pl_info & " . pl_talk . ")";
	$sql .= " and not pl_song like '%talk%'";
	$sql .= " order by pl_sort";
	$ary = $db->confessor_data($sql,$num,true);
	if($num)
	{
		foreach($ary as $row)
		{
			$start_dt = $row["ph_date"] + $row["pl_start"];
			$start_str = date("g:i",$start_dt);
			$big_ary[$row["pl_sort"]] = array("start" => $start_str,
				"start_dt" => $start_dt,
				"title" => $row["pl_song"],
				"artist" => $row["pl_artist"],
				"album" => $row["pl_album"],
				"label" => $row["pl_label"],
				"length" => time_from_secs($row["pl_len"]),
				"row" => $row);
		}
	}
$db->write_log("big_ary=" . print_r($big_ary,true) . "\n");
	return($big_ary);
}

function get_most_recent_playlist($shaltid)
{
	global $db;
	global $gl_row;
	
	$now = time();

	$big_ary = array();

	$sql = "select * from " . $db->confessor_tables("sh_table,ph_table");
	$sql .= " where sh_altid='$shaltid'";
	$sql .= " and ph_date < $now";
	$sql .= " and ph_shid=sh_id";
	$sql .= " and not sh_info & " . (sh_talk);
	$sql .= " order by ph_date desc limit 1";
	$row = $db->confessor_data($sql,$num);
	if($num)
	{
		if(empty($row["sh_it_photo"]))
		{
			$big_pix = get_stapix();
$db->write_log("row.sh_it_photo=" . $row["sh_it_photo"] . "\n");
		}
		else
		{
//			$big_pix = $gl_row["gl_pixurl"] . "/" . $row["sh_it_photo"];
			$big_pix = pix_url . "/" . $row["sh_it_photo"];
		}

		if(empty($row["sh_med_photo"]))
		{
//			$med_pix = $gl_row["gl_pixurl"] . "/" . $gl_row["gl_stapix"];
			$med_pix = pix_url . "/" . $gl_row["gl_stapix"];
		}
		else
		{
//			$med_pix = $gl_row["gl_pixurl"] . "/" . $row["sh_med_photo"];
			$med_pix = pix_url . "/" . $row["sh_med_photo"];
		}

		if(empty($row["sh_photo"]))
		{
//			$pix = $gl_row["gl_pixurl"] . "/" . $gl_row["gl_stapix"];
			$pix = pix_url . "/" . $gl_row["gl_stapix"];
		}
		else
		{
//			$pix = $gl_row["gl_pixurl"] . "/" . $row["sh_photo"];
			$pix = pix_url . "/" . $row["sh_photo"];
		}
		$big_ary["show"]["pix"] = $pix;
		$big_ary["show"]["med_pix"] = $med_pix;
		$big_ary["show"]["big_pix"] = $big_pix;
		$big_ary["show"]["date"] = date("l, F j, Y",$row["ph_date"]);
		$big_ary["show"]["time"] = date("g:i A",$row["ph_date"]);
		$big_ary["show"]["name"] = $row["sh_name"];
		$big_ary["show"]["dj"] = $row["sh_djname"];
		$big_ary["show"]["desc"] = $row["sh_desc"];
		$big_ary["show"]["short_desc"] = $row["sh_shortdesc"];
		$row["pix"] = $pix;
		$row["big_pix"] = $big_pix;
		$big_ary["show"]["row"] = $row;

		$sql = "select " . $db->confessor_tables("pl_table") . ".*," . $db->confessor_tables("ph_table") . ".ph_date from " . $db->confessor_tables("pl_table,ph_table");
		$sql .= " where pl_phid=ph_id";
		/*
		if($type == 'date')
			$sql .= " and ph_date=$phid";
		else if($type == "phid")
			$sql .= " and ph_id=$phid";
		*/
		$sql .= " and ph_id=" . $row["ph_id"];
		$sql .= " and pl_start > -1";
		$sql .= " and pl_len > 0";
		$sql .= " and not (pl_info & " . pl_talk . ")";
		$sql .= " and not pl_song like '%talk%'";
		$sql .= " order by pl_sort";
		$ary = $db->confessor_data($sql,$num,true);
		if($num)
		{
			foreach($ary as $pl_row)
			{
				$start_dt = $pl_row["ph_date"] + $pl_row["pl_start"];
				$start_str = date("g:i",$start_dt);
				$big_ary[$pl_row["pl_sort"]] = array("start" => $start_str,
					"start_dt" => $start_dt,
					"title" => $pl_row["pl_song"],
					"artist" => $pl_row["pl_artist"],
					"album" => $pl_row["pl_album"],
					"label" => $pl_row["pl_label"],
					"length" => time_from_secs($pl_row["pl_len"]),
					"row" => $pl_row);
			}
		}
	}
	return($big_ary);
}

function get_header_by_id($id,$dte)
{
	global $db;

	$ret_val = 0;

	// get midnight tomorrow
	$dt_ary = getdate($dte);
	$nudte = mktime(0,0,0,$dt_ary["mon"],$dt_ary["mday"] + 1,$dt_ary["year"]);

	$sql = "select ph_id from " . $db->confessor_tables("ph_table,sh_table");
	$sql .= " where ph_shid=sh_id";
	$sql .= " and ph_start < $nudte";
	$sql .= " and sh_altid='" . $id . "'";
	$sql .= " order by ph_date desc limit 1";
	$row = $db->confessor_data($sql,$num);
	if(!empty($row))
		$ret_val = $row["ph_id"];

	return($ret_val);
}

function get_show_dates($idkey)
{
	global $db;

	$now = time();

	$big_ary = array();

	$sql = "select * from " . $db->confessor_tables("sh_table,ph_table");
	$sql .= " where ph_shid=sh_id";
	$sql .= " and sh_altid='" . $idkey . "'";
	$sql .= " and ph_date <= $now";
	$sql .= " and not sh_info & " . (sh_talk);
	$sql .= " order by ph_date desc";
	$ary = $db->confessor_data($sql,$num,true);

	if($num)
	{
		$count = 0;
		foreach($ary as $row)
		{
			$dt = $row["ph_date"];
			$big_ary[$count]["dt"] = $dt;
			$big_ary[$count]["phid"] = $row["ph_id"];
			$big_ary[$count]["key"] = $row["sh_altid"];
			$big_ary[$count]["name"] = $row["sh_name"];
			$big_ary[$count]["producer"] = $row["sh_djname"];
			$big_ary[$count]["date"] = date("D j M, Y",$dt);
			$big_ary[$count]["time"] = date("g:i A",$dt);
			if($row['sh_info'] & sh_talk)
				$big_ary[$count]["type"] = "Talk";
			else
				$big_ary[$count]["type"] = "Music";
			$count++;
		}
	}
	return($big_ary);
}

function get_stapix()
{
	global $gl_row;

//	$file_root = $gl_row["gl_pixurl"];
//	$file_root = pix_url;
	$ext = "jpg";		// itunes wants a jpeg
	$fil = str_replace(array(".gif",".png",".jpg"),"",$gl_row["gl_stapix"]);
//	$itunes_file = $file_root . "/" . $fil . '_it_' . '.' . $ext;
	$itunes_file = pix_url . "/" . $fil . '_it_' . '.' . $ext;

	return($itunes_file);
}

function get_show($id)
{
	global $db;
	global $gl_row;

	$ary = array();

	$phid = 0;

	$sql = "select * from " . $db->confessor_tables("ph_table,sh_table");
	$sql .= " where sh_id=ph_shid";
	$sql .= " and ph_id=$id";
	$row = $db->confessor_data($sql,$num);

	if(!empty($row))
	{
		if(empty($row["sh_it_photo"]))
		{
			$row["sh_it_photo"] = get_stapix();
			$big_pix = $row["sh_it_photo"];
		}
		else
		{
//			$big_pix = $gl_row["gl_pixurl"] . "/" . $row["sh_it_photo"];
			$big_pix = pix_url . "/" . $row["sh_it_photo"];
		}

		if(empty($row["sh_med_photo"]))
		{
//			$row["sh_med_photo"] = $gl_row["gl_pixurl"] . "/" . $gl_row["gl_stapix"];
			$row["sh_med_photo"] = pix_url . "/" . $gl_row["gl_stapix"];
			$med_pix = $row["sh_med_photo"];
		}
		else
		{
//			$med_pix = $gl_row["gl_pixurl"] . "/" . $row["sh_med_photo"];
			$med_pix = pix_url . "/" . $row["sh_med_photo"];
		}

		if(empty($row["sh_photo"]))
		{
//			$row["sh_photo"] = $gl_row["gl_pixurl"] . "/" . $gl_row["gl_stapix"];
			$row["sh_photo"] = pix_url . "/" . $gl_row["gl_stapix"];
			$pix = $row["sh_photo"];
		}
		else
		{
//			$pix = $gl_row["gl_pixurl"] . "/" . $row["sh_photo"];
			$pix = pix_url . "/" . $row["sh_photo"];
		}
		$row["date"] = date("l, F j, Y",$row["ph_date"]);
		$row["time"] = date("g:i A",$row["ph_date"]);
		$ary["show"] = $row;
		$ary["pix"] = $pix;
		$ary["med_pix"] = $med_pix;
		$ary["big_pix"] = $big_pix;
		if($row['sh_info'] & sh_talk)
			$ary["type"] = "Talk";
		else
			$ary["type"] = "Music";

		$pl_ary = get_playlist("phid",$row["ph_id"]);
		foreach($pl_ary as $key => $val)
		{
			$ary[$key] = $val;
		}
	}
	return($ary);
}

function get_now_ary()
{
	$curfile_name = "playlist/_pl_current_ary.php";
	$big_ary = [];

	if(file_exists($curfile_name))
	{
		$ary = json_decode(file_get_contents($curfile_name),true);
		foreach($ary as $val)
		{
			foreach($val as $key => $a)
				$big_ary[$key] = $a;
		}
	}
	return($big_ary);
}

function get_days($shid)
{
	global $now;
	global $db;
	$lil_str = '';
	$big_str = '';

	$sunday = get_sunday($now);
	$dtary = getdate($sunday);
$db->write_log("dtary=" . print_r($dtary,true) . "\n");
	$nxt_sunday = mktime(0,0,0,$dtary["mon"],(int)$dtary["mday"] + 7,$dtary["year"]);
$db->write_log("nxt_sunday=" . date("r",$nxt_sunday) . "\n");
	$sql = "select ph_date from " . $db->confessor_tables("ph_table");
	$sql .= " where ph_shid=$shid";
	$sql .= " and ph_date between $sunday and $nxt_sunday";
	$sql .= " order by ph_date asc";
	$ary = $db->confessor_data($sql,$num,true);
$db->write_log("sql=$sql\n");
	foreach($ary as $row)
	{
		$lil_str .= date("D",$row["ph_date"]) . ",";
		$big_str .= date("l",$row["ph_date"]) . ",";
	}
	$lil_str = rtrim($lil_str,",");
	$big_stwr = rtrim($big_str,",");

	return(Array("big" => $big_str,"lil" => $lil_str));
}

function get_cat($sh_caid)
{
	global $db;
	$ca_table = $db->confessor_tables("ca_table");

	$sql = "select ca_name,ca_color,ca_bgcolor,ca_lcolor from $ca_table";
	$sql .= " where ca_id=$sh_caid";
	$row = $db->confessor_data($sql,$num);

	return($row);
}

function get_current($now = 0)
{
	global $db;
	global $gl_row;

	$row = array();

	if(empty($now))
		$now = time();
	
	$sql = "select ph_id,ph_date,ph_shlen,ph_info," . $db->confessor_tables("sh_table") . ".* from " . $db->confessor_tables("ph_table,sh_table");
	$sql .= " where ph_date <= $now";
	$sql .= " and sh_id=ph_shid";
	$sql .= " and not sh_info & " . (sh_gone);
	$sql .= " order by ph_start desc";
	$sql .= " limit 1";
	$ph_row = $db->confessor_data($sql,$num);
$db->write_log(": ph_row=" . print_r($ph_row,true) . "\n");

$db->write_log(" now i'm calling get_days\n");
	$days_ary = get_days($ph_row["sh_id"]);
	
	$time_str = date("h:i A",$ph_row["ph_date"]);
//	$time_str = time_from_secs($ph_row["sh_shour"],1);
//	$day_str = show_days($ph_row["sh_info"]);
//	$end_time_str = time_from_secs($ph_row["sh_shour"] + $ph_row["sh_len"]);
	$dte_ary = getdate($ph_row["ph_date"]);
	if($dte_ary["hours"] == 0 && $dte_ary["minutes"] == 0)
		$start_time_str = "Midnight";
	else if($dte_ary["hours"] == 12 && $dte_ary["minutes"] == 0)
		$start_time_str = "Noon";
	else
		$start_time_str = date("g:i A",$ph_row["ph_date"]);
	$edte = mktime($dte_ary["hours"],$dte_ary["minutes"],$dte_ary["seconds"] + $ph_row["ph_shlen"],$dte_ary["mon"],$dte_ary["mday"],$dte_ary["year"]);
	$endte_ary = getdate($edte);
	if($endte_ary["hours"] == 0 && $endte_ary["minutes"] == 0)
		$end_time_str = "Midnight";
	else if($endte_ary["hours"] == 12 && $endte_ary["minutes"] == 0)
		$end_time_str = "Noon";
	else
		$end_time_str = date("g:i A",$edte);
//	$start_time = get_start_time($ph_row["sh_shour"]);

	$row['sh_id'] = $ph_row['sh_id'];
	$row['sh_name'] = $ph_row['sh_name'];
	$row['sh_altid'] = $ph_row['sh_altid'];
	$row["sh_memsysid"] = $ph_row["sh_memsysid"];
	if(!empty($row['sh_photo']))
//		$row['sh_photo'] = $gl_row["gl_pixurl"] . "/" . $ph_row['sh_photo'];
		$row['sh_photo'] = pix_url . "/" . $ph_row['sh_photo'];
	else
		$row['sh_photo'] = '';
	if(!empty($row['sh_med_photo']))
//		$row['sh_med_photo'] = $gl_row["gl_pixurl"] . "/" . $ph_row['sh_med_photo'];
		$row['sh_med_photo'] = pix_url . "/" . $ph_row['sh_med_photo'];
	else
		$row['sh_med_photo'] = pix_dir . "/" . $gl_row["gl_stapix"];
	$row['sh_djname'] = $ph_row['sh_djname'];
	$row['sh_desc'] = $ph_row['sh_desc'];
	$row['sh_shortdesc'] = $ph_row['sh_shortdesc'];
	$row['sh_info'] = $ph_row['sh_info'];
//	$row['sh_shour'] = $ph_row['sh_shour'];
	$row['sh_shour'] = date("H",$ph_row['ph_date']);
	$row['sh_stime'] = $start_time_str;
	$row['sh_ampm'] = ampm_time_from_secs($ph_row["sh_shour"],1);
	$row['sh_days'] = $days_ary["lil"];
	$row["sh_big_days"] = $days_ary["big"];
	$row['sh_ends'] = $end_time_str;
	$row['sh_ampm_ends'] = ampm_time_from_secs($ph_row["sh_shour"] + $ph_row["sh_len"],1);
	$row['sh_len'] = $ph_row['sh_len'];
	$row['sh_url'] = $ph_row['sh_url'];
	$row['sh_facebook'] = $ph_row['sh_facebook'];
	$row['sh_twitter'] = $ph_row['sh_twitter'];
	$row['sh_tumblr'] = $ph_row['sh_tumblr'];
	$cat = get_cat($ph_row["sh_caid"]);
	$row["cat"] = $cat["ca_name"];
	$row["cat_color"] = $cat["ca_color"];
	$row["cat_bgcolor"] = $cat["ca_bgcolor"];
//	$row['sh_start_time'] = $start_time;
	if($ph_row['sh_info'] & sh_talk)
		$row["type"] = "Talk";
	else
		$row["type"] = "Music";
	
	return($row);
}

/*
function get_current($now = 0)
{
	global $db;
	global $gl_row;

	$row = array();

	if(empty($now))
		$now = time();

	$sql = "select ph_id,ph_info," . $db->confessor_tables("sh_table") . ".* from " . $db->confessor_tables("ph_table,sh_table");
	$sql .= " where ph_start <= $now";
	$sql .= " and sh_id=ph_shid";
	$sql .= " and not sh_info & " . (sh_gone);
	$sql .= " order by ph_start desc";
	$sql .= " limit 1";
	$ph_row = $db->confessor_data($sql,$num);
$db->write_log(": ph_row=" . print_r($ph_row,true) . "\n");
	
	$time_str = time_from_secs($ph_row["sh_shour"],1);
	$day_str = show_days($ph_row["sh_info"]);
	$end_time_str = time_from_secs($ph_row["sh_shour"] + $ph_row["sh_len"]);
	$start_time = get_start_time($ph_row["sh_shour"]);
$db->write_log("back from get_start_time: start_time=$start_time\n");

	$row['sh_id'] = $ph_row['sh_id'];
	$row['sh_name'] = $ph_row['sh_name'];
	$row['sh_altid'] = $ph_row['sh_altid'];
	$row["sh_memsysid"] = $ph_row["sh_memsysid"];
	if(!empty($row['sh_photo']))
//		$row['sh_photo'] = $gl_row["gl_pixurl"] . "/" . $ph_row['sh_photo'];
		$row['sh_photo'] = pix_url . "/" . $ph_row['sh_photo'];
	else
		$row['sh_photo'] = '';
	if(!empty($row['sh_med_photo']))
//		$row['sh_med_photo'] = $gl_row["gl_pixurl"] . "/" . $ph_row['sh_med_photo'];
		$row['sh_med_photo'] = pix_url . "/" . $ph_row['sh_med_photo'];
	else
		$row['sh_med_photo'] = '';
	$row['sh_djname'] = $ph_row['sh_djname'];
	$row['sh_info'] = $ph_row['sh_info'];
	$row['sh_shour'] = $ph_row['sh_shour'];
	$row['sh_stime'] = $time_str;
	$row['sh_ampm'] = ampm_time_from_secs($ph_row["sh_shour"],1);
	$row['sh_days'] = $day_str;
	$row["sh_big_days"] = show_long_days($ph_row["sh_info"]);
	$row['sh_ends'] = $end_time_str;
	$row['sh_ampm_ends'] = ampm_time_from_secs($ph_row["sh_shour"] + $ph_row["sh_len"],1);
	$row['sh_len'] = $ph_row['sh_len'];
	$row['sh_url'] = $ph_row['sh_url'];
	$row['sh_facebook'] = $ph_row['sh_facebook'];
	$row['sh_twitter'] = $ph_row['sh_twitter'];
	$row['sh_tumblr'] = $ph_row['sh_tumblr'];
	$row['sh_start_time'] = $start_time;
	if($ph_row['sh_info'] & sh_talk)
		$row["type"] = "Talk";
	else
		$row["type"] = "Music";
	
	return($row);
}
*/

function get_current_ph($now = 0)
{
	global $db;

	$row = array();

	if(empty($now))
		$now = time();
	
	$sql = "select ph_id,ph_shid,ph_info from " . $db->confessor_tables("ph_table");
	$sql .= " where ph_start < $now";
	$sql .= " order by ph_start desc";
	$sql .= " limit 1";
	$row = $db->confessor_data($sql,$numm);
	
	return($row);
}

function get_song($now = 0)
{
	global $db;

	$row = array();

	if(empty($now))
		$now = time();
	
	$ph_row = get_current_ph($now);

	$sql = "select pl_song,pl_artist,pl_album,pl_label,pl_info from " . $db->confessor_tables("pl_table");
	$sql .= " where pl_phid=" . $ph_row['ph_id'];
	$sql .= " and pl_start >= 0";
	$sql .= " and pl_len=0";
	$sql .= " order by pl_start desc";
	$sql .= " limit 1";
	$row = $db->confessor_data($sql,$num);

	if($num)
	{
		if($row['pl_info'] & pl_talk)
		{
			$row['pl_song'] = 'Talking . . .';
			$row['pl_artist'] = '';
			$row['pl_album'] = '';
			$row['pl_label'] = '';
		}
		else if($row['pl_song'] == 'Show Start')
		{
			$row['pl_song'] = '';
			$row['pl_artist'] = '';
			$row['pl_album'] = '';
			$row['pl_label'] = '';
		}
	}
	else
	{
		$row['pl_artist'] = '';
		$row['pl_song'] = '';
		$row['pl_album'] = '';
		$row['pl_label'] = '';
	}
	return($row);
}

function get_next_sunday($dte)
{
	$dtary = getdate($dte);
	$diff = $dtary["mday"] + (7 - $dtary["wday"]);
	$sundte = mktime(0,0,0,$dtary["mon"],$diff,$dtary["year"]);
	return($sundte);
}

function get_sched_weeks($wks,$plistid = '')
{
	global $db;

	$showsDb = new Scheds($db,$wks,0,"no_gone_shows:1");

	if(!empty($plistid))
		$ary = $showsDb->get_shows_by_plistid($plistid);	
	else
		$ary = $showsDb->get_all_shows_short();	
$db->write_log("ary=" . print_r($ary,true) . "\n");
	return($ary);
}

function get_sched($stdte,$endte,$plistid = '')
{
	global $db;

	$nustdte = get_sunday($stdte);
$db->write_log("stdte=" . date("m-d-y H:i",$stdte) . " - nustdte=" . date("m-d-y H:i",$nustdte) . "\n");
	if(!empty($endte))
	{
		$nuendte = get_next_sunday($endte);
		$wks = round(((($nuendte - $nustdte) / SECS_IN_DAY) / 7),0);
$db->write_log("wks=$wks - nustdte=" . date("m-d-y",$nustdte) . " - nuendte=" . date("m-d-y",$nuendte) . "\n");
	}
	else
		$wks = 0;
	$pods = new Scheds($db,1,$wks,"no_gone_shows:1,start_date:" . $nustdte);

	if(!empty($plistid))
		$ary = $pods->get_shows_by_plistid($plistid);	
	else
		$ary = $pods->get_all_shows_short();	
$db->write_log("ary=" . print_r($ary,true) . "\n");

	return($ary);
}

function get_pledge($now = 0)
{
	global $db;
	global $gl_row;

	$ary = array();

	if(empty($gl_row["gl_pledgeurl"]))
		return($ary);

	$altid = '';
	$tip_jar = '';

	$ph_row = get_current_ph($now);
	if(!empty($ph_row))
	{
		$sql = "select sh_altid from " . $db->confessor_tables("sh_table");
		$sql .= " where sh_id=" . $ph_row["ph_shid"];
		$row = $db->confessor_data($sql,$num);
		if(!empty($row))
		{
			$altid = $row["sh_altid"];
		}
		$ary["url"] = $gl_row["gl_pledgeurl"] . "?id=$altid";
		if(!empty($gl_row["gl_pledgeimage"]))
		{
			 if(!empty($gl_row['gl_pledgeimage']))
			 {
				$pledge_over_img = substr($gl_row['gl_pledgeimage'],0,strrpos($gl_row['gl_pledgeimage'],'.')) . "_over.gif";
				$pledge_out_img = substr($gl_row['gl_pledgeimage'],0,strrpos($gl_row['gl_pledgeimage'],'.')) . "_out.gif";
				$tip_jar = <<<DYI
	<a href="{$gl_row['gl_pledgeurl']}?id=$altid" target="_blank">
	<table width="100%" border="0">
	 <tr>
	  <td width="15px">&nbsp;</td>
      <td align="center">
	   <table width="150px" border="0">
	    <tr>
	     <td width="50%" class="tipJar" align="center">
	      Like the show?<br>Click on the Tip Jar!
	     </td>
		 <td align="left">
		  <img src="{$gl_row['gl_pledgeimage']}" border="0" 
		   onmouseover="this.src='$pledge_over_img'" 
		   onmouseout="this.src='$pledge_out_img'">
         </td>
        </tr>
       </table>
      </td></tr></table>
     </a>
DYI;
}
else
{
	$tip_jar = <<<DXI
<a href="{$gl_row['gl_pledgeurl']}" class="tipJar" target="_blank">
Like the show?<br>Click to Leave a tip!<br>
</a>
DXI;
}
		}
	}
	$ary["tipjar"] = $tip_jar;
	return($ary);
}

$str = '';
$ary = array();

if(empty($_GET))
	exit('bad');

$json_flag = !empty($_GET['json']);

$req = $_GET['req'];

$db->write_log("get=" . print_r($_GET,true) . "\n");
if($req == 'nowary')
{
	$ary = get_now_ary();
}
if($req == 'getshows')
{
	$before = $after = 1;

	if(!empty($_GET["before"]))
	{
		$before = intval($_GET["before"]);
		if(!empty($_GET["after"]))
			$after = intval($_GET["after"]);
	}
	$ary = get_shows($before,$after);
}
else if ($req == "shotimes")
{
	if(empty($_GET["key"]))
		$key = '';
	else
		$key = substr($_GET["key"],0,35);
	$ary = get_show_dates($key);
}
else if ($req == "playlist")
{
	if(!empty($_GET["date"]))
	{
		$dtstr = substr($_GET['date'],0,20);
$db->write_log($dtstr . "\n");
//		$phid = intval($_GET["date"]);
		if(!is_numeric($dtstr))
			$phid = strtotime($dtstr);
		else
			$phid = intval($dtstr);
$db->write_log(date("r",$phid) . "\n");
		$type = "date";
	}
	else if(!empty($_GET["phid"]))
	{
		$phid = intval($_GET["phid"]);
		$type = "phid";
	}
	else if(!empty($_GET["dt"]) && !empty($_GET["key"]))
	{
		$dte = strtotime(substr($_GET["dt"],0,10));
		$id = substr($_GET["key"],0,35);
		$phid = get_header_by_id($id,$dte);
		$type = "phid";
	}
	else
	{
		$phid = time();
		$type = 'date';
	}
	$ary = get_playlist($type,$phid);
}
else if($req == "all")
{
	if(!empty($_GET["key"]))
	{
		$key = substr($_GET["key"],0,35);
		$ary = get_all_altid_playlists($key);
	}
}
else if($req == "getshow")
{
	if(empty($_GET["dte"]))
		$tim = time();
	else
	{
		$tim = intval($_GET["dte"]);
	}
	$ary = get_current($tim);	// current time
}
else if($req == "getnext")
{
	if(empty($_GET["dte"]))
		$tim = time();
	else
	{
		$tim = intval($_GET["dte"]);
	}
	$ary = get_next($tim);	// current time
}
else if($req == "getcurrent")
{
	if(empty($_GET["dte"]))
		$tim = time();
	else
	{
		$tim = intval($_GET["dte"]);
	}
	$ary["current"] = get_current($tim);
	$ary["next"] = get_next($tim);	// current time
}
else if($req == "getday")
{
	if(!isset($_GET["day"]))
		$day = date("w");	
	else
	{
		$day = intval($_GET["day"]);
		if($day > 6)
			$day %= 7;
	}
	$ary = get_one_day($day);		// day = 0=6
}
else if($req == "getnow")
{
	if(!empty($_GET["time"]))
		$tim = intval($_GET["time"]);
	else
		$tim = time();
	
	$ary = get_song($tim);
}
else if($req == "getalfa")
{
	$ary = get_shows_by_alfa();
}
else if($req == 'getary')
{
	$ary = get_show_ary_by_time();
}
else if($req == 'key')
{
	$ary = get_show_by_key(substr($_GET["key"],0,35));
}
else if($req == 'getgone')
{
	$ary = get_gone();
}
else if($req == 'list')
{
	$ary = get_list();
}
else if($req == 'altids')
{
	$ary = get_altids();
}
else if($req == 'memsys')
{
	$ary = get_memsys_ids();
}
else if($req == "show")
{
	if(!empty($_GET["id"]))
		$ary = get_show(intval($_GET["id"]));
}
else if($req == "pledge")
{
	$ary = get_pledge($now);
}
else if($req == "mostrecent")
{
	$altid = substr($_GET["altid"],0,30);
	$ary = get_most_recent_playlist($altid);
}
else if($req == "sched")
{
	if(!empty($_GET["wks"]))
	{
		$wks = intval($_GET["wks"]);
		if(!empty($_GET["plistid"]))
			$plistid = substr($_GET["plistid"],0,36);
		else
			$plistid = '';
		$ary = get_sched_weeks($wks,$plistid);
	}
	else
	{
		if(is_numeric($_GET["stdte"]))
			$stdte = intval($_GET["stdte"]);
		else
			$stdte = strtotime($_GET["stdte"]);
		if(is_numeric($_GET["endte"]))
			$endte = intval($_GET["endte"]);
		else
			$endte = strtotime($_GET["endte"]);
		if(!empty($_GET["plistid"]))
			$plistid = substr($_GET["plistid"],0,36);
		else
			$plistid = '';
		$ary = get_sched($stdte,$endte,$plistid);
	}
}
else if($req == 'special')
{
	if(!empty($_GET["wks"]))
	{
		$wks = intval($_GET["wks"]);
		if(!empty($_GET["plistid"]))
			$plistid = substr($_GET["plistid"],0,36);
		else
			$plistid = '';
		if(!empty($_GET["endte"]))
			if(is_numeric($_GET["endte"]))
				$endte = intval($_GET["endte"]);
			else
				$endte = strtotime($_GET["endte"]);
		$ary = get_special_sched_weeks($wks,$endte,$plistid);
	}
	else
	{
		if(is_numeric($_GET["stdte"]))
			$stdte = intval($_GET["stdte"]);
		else
			$stdte = strtotime($_GET["stdte"]);
		if(is_numeric($_GET["endte"]))
			$endte = intval($_GET["endte"]);
		else
			$endte = strtotime($_GET["endte"]);
		if(!empty($_GET["plistid"]))
			$plistid = substr($_GET["plistid"],0,36);
		else
			$plistid = '';
		$ary = get_special_sched($stdte,$endte,$plistid);
	}
}
else if($req == 'nowshow')
{
	$ary = get_nowplaying_show();
}
else if($req == 'nowshort')
{
$db->write_log("calling get_nowplaying_short\n");
	$ary = get_nowplaying_short();
}
else if($req == 'fil')
{
	$num = 0;
	if(!empty($_GET["id"]))
	{
		$id = substr($_GET["id"],0,35);
		if(isset($_GET["num"]))
			$num = intval($_GET["num"]);
		$ary = get_filnams($id,$num);
	}
}
else if($req == 'jsched')
{
	$str = file_get_contents("sched_by_day_with_fold.json");
	$ary = [];
}

$db->write_log("ary=" . print_r($ary,true) . "\n");

if(!empty($ary))
{
	$str = '';

	if($json_flag)
		$str = json_encode($ary,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_NUMERIC_CHECK);
	else
		$str = base64_encode(serialize($ary));
	if($json_flag)
		$db->write_log(print_r(json_decode($str,JSON_OBJECT_AS_ARRAY),true) . "\n");
	else
		$db->write_log(print_r(unserialize(base64_decode($str)),true) . "\n");
}
print $str;
?>
